param(
    [string]$backupPath,
    [string]$candidateImage,
    [string]$rollbackImage,
    [string]$outputRoot,
    [hashtable]$bindSourceMap = @{},
    [switch]$execute
)
$ErrorActionPreference = "Stop"
if (-not $backupPath -or -not $candidateImage -or -not $rollbackImage -or -not $outputRoot) {
    Write-Output "用法：dockerUpgrade.ps1 -BackupPath <备份绝对目录> -CandidateImage <本地候选镜像> -RollbackImage <本地旧镜像> -OutputRoot <全新绝对目录> [-Execute]"
    Write-Output "默认仅输出只读计划。-Execute 只运行隔离启动演练，不执行生产部署或证明业务回滚成功。"
    throw "缺少必填参数，未执行演练。"
}

function absoluteLocalPath([string]$path) {
    if (-not [IO.Path]::IsPathRooted($path) -or $path -match '^[\\/]{2}' -or $path -match '[,"&|<>^%!()\r\n]') { throw "必须使用无逗号、换行或命令行特殊字符的本机绝对路径：$path" }
    $full = [IO.Path]::GetFullPath($path)
    if ($full -ne $path.TrimEnd([char[]]"\/")) { throw "路径必须完整规范化，不能包含相对段或盘符相对路径：$path" }
    $cursor = $full
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "不接受符号链接或目录联接：$cursor" }
        }
        $cursor = [IO.Path]::GetDirectoryName($cursor)
    }
    return $full
}

$backup = absoluteLocalPath $backupPath
$output = absoluteLocalPath $outputRoot
if (-not (Test-Path -LiteralPath $backup -PathType Container)) { throw "备份目录不存在。" }
if (Test-Path -LiteralPath $output) { throw "输出目录已存在；请指定全新目录，避免覆盖演练数据。" }
if (-not (Test-Path -LiteralPath ([IO.Path]::GetDirectoryName($output)) -PathType Container)) { throw "输出目录的父目录必须已经存在。" }
$separator = [IO.Path]::DirectorySeparatorChar
$comparison = [StringComparison]::OrdinalIgnoreCase
if ($backup.Equals($output, $comparison) -or $output.StartsWith("$backup$separator", $comparison) -or $backup.StartsWith("$output$separator", $comparison)) {
    throw "备份与输出目录必须独立，不能互相包含。"
}
$manifestPath = absoluteLocalPath (Join-Path $backup "manifest.json")
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) { throw "缺少备份 manifest.json。" }
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
if ($manifest.version -ne 1 -or $manifest.salt -cnotmatch '^[a-f0-9]{32}$' -or $manifest.iv -cnotmatch '^[a-f0-9]{24}$' -or
    $manifest.tag -cnotmatch '^[a-f0-9]{32}$' -or $manifest.data -isnot [string] -or -not $manifest.data) { throw "备份外层格式无效。" }
try { $null = [Convert]::FromBase64String($manifest.data) } catch { throw "备份密文不是有效 Base64。" }
$backupScript = absoluteLocalPath (Join-Path $PSScriptRoot "dataBackup.ts")
if (-not (Test-Path -LiteralPath $backupScript -PathType Leaf)) { throw "缺少现有 dataBackup.ts 恢复工具。" }
$bunCommand = (Get-Command bun -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
$dockerCommand = (Get-Command docker -CommandType Application -ErrorAction Stop | Select-Object -First 1).Source
if ($env:DOCKER_HOST) { throw "检测到 DOCKER_HOST；请先清除该覆盖，明确使用本机 Docker context。" }
$context = (& $dockerCommand context show | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or -not $context -or $context -match '[\r\n]') { throw "无法确定 Docker context。" }
$endpoint = (& $dockerCommand context inspect $context --format '{{.Endpoints.docker.Host}}' | Out-String).Trim()
if ($LASTEXITCODE -ne 0 -or ($endpoint -notmatch '^npipe:////\./pipe/[a-zA-Z0-9_.-]+$' -and $endpoint -notmatch '^unix:///[^\r\n]+$')) {
    throw "仅支持本机 named pipe 或 Unix socket Docker endpoint，拒绝远程或无法确认的目标。"
}
$previousContext = $env:DOCKER_CONTEXT
try {
    $env:DOCKER_CONTEXT = $null
    $osType = (& $dockerCommand --host $endpoint info --format '{{.OSType}}' | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $osType -ne "linux") { throw "需要可用的本机 Linux 容器引擎。" }
    $daemonId = (& $dockerCommand --host $endpoint info --format '{{.ID}}' | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $daemonId) { throw "无法确定本机 Docker daemon 身份。" }
    function assertDockerTarget {
        $currentEndpoint = (& $dockerCommand context inspect $context --format '{{.Endpoints.docker.Host}}' | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $currentEndpoint -ne $endpoint) { throw "Docker context 目标已改变，停止演练。" }
        $currentDaemon = (& $dockerCommand --host $endpoint info --format '{{.ID}}' | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $currentDaemon -ne $daemonId) { throw "Docker daemon 身份已改变或无法核对，停止演练。" }
    }
    function confirmBindIdentity([string]$source, [string]$hostPath) {
        if ($source -match '[,"\r\n]') { throw "历史挂载来源包含无法安全传递的字符。" }
        $stage = "mapping$($startedContainers.Count)"
        $name = "toonflow-drill-$stage-$([Guid]::NewGuid().ToString('N'))"
        $identityCode = 'import {statSync} from "@toonflow/file"; const read=path=>{const value=statSync(path,{bigint:true});return {device:value.dev.toString(),inode:value.ino.toString(),type:value.isDirectory()?"directory":value.isFile()?"file":"other"};}; const source=read("/source"),host=read("/host"); if(source.inode==="0"||source.device!==host.device||source.inode!==host.inode||source.type!==host.type||source.type==="other")throw new Error("Bind source identity mismatch");console.log(JSON.stringify({source,host,matched:true}));'
        assertDockerTarget
        $id = (& $dockerCommand --host $endpoint create --pull never --name $name --network none --read-only --user 0 --entrypoint bun --workdir /app --mount "type=bind,source=$source,target=/source,readonly" --mount "type=bind,source=$hostPath,target=/host,readonly" $images.candidate -e $identityCode | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $id -notmatch '^[a-f0-9]{64}$') { throw "无法创建只读挂载核实容器，未接受映射。" }
        $script:startedContainers += @{ id = $id; stage = $stage }
        assertDockerTarget
        $identityJson = @(& $dockerCommand --host $endpoint start --attach $id)
        if ($LASTEXITCODE -ne 0) { throw "历史挂载身份核实失败，保留 helper 容器日志：$id" }
        $exitCode = & $dockerCommand --host $endpoint inspect $id --format '{{.State.ExitCode}}'
        if ($LASTEXITCODE -ne 0 -or $exitCode -ne "0" -or $identityJson.Count -ne 1) { throw "历史挂载身份无法确认，未接受映射。" }
        $identity = $identityJson[0] | ConvertFrom-Json
        if ($identity.matched -ne $true) { throw "历史挂载来源与主机路径不一致，未接受映射。" }
        Write-Output "历史挂载身份已核对：$source -> $hostPath；device=$($identity.source.device)；inode=$($identity.source.inode)；type=$($identity.source.type)"
    }
    function assertOutputUnmapped([switch]$verifyMappings) {
        assertDockerTarget
        $containers = & $dockerCommand --host $endpoint ps --all --quiet --no-trunc
        if ($LASTEXITCODE -ne 0) { throw "无法检查已有容器的数据挂载，停止演练。" }
        foreach ($id in $containers) {
            if ($startedContainers.id -contains $id) { continue }
            $mountJson = & $dockerCommand --host $endpoint inspect $id --format '{{json .Mounts}}'
            if ($LASTEXITCODE -ne 0) { throw "无法检查已有容器的数据挂载，停止演练。" }
            foreach ($mount in ($mountJson | ConvertFrom-Json)) {
                if (-not $mount.RW -or $mount.Type -eq "tmpfs") { continue }
                $source = [string]$mount.Source
                if ($env:OS -eq "Windows_NT" -and $source -notmatch '^[a-zA-Z]:[\\/]') {
                    if ($mount.Type -ne "bind") { continue }
                    $keys = @($bindSourceMap.Keys | Where-Object { $_ -ceq $source })
                    if ($keys.Count -ne 1 -or $bindSourceMap[$keys[0]] -isnot [string]) { throw "已有容器 bind 来源无法确认对应的本机路径：$source；请通过 BindSourceMap 提供精确候选路径，Execute 会只读核对身份。" }
                    $hostPath = absoluteLocalPath $bindSourceMap[$keys[0]]
                    if (-not (Test-Path -LiteralPath $hostPath)) { throw "候选主机挂载路径不存在，未接受映射。" }
                    if ($verifyMappings) { confirmBindIdentity $source $hostPath }
                    else { Write-Warning "历史挂载候选待 Execute 身份核对：$source -> $hostPath；当前只读计划不证明映射安全。" }
                    $source = $hostPath
                }
                $source = absoluteLocalPath $source
                if ($source.Equals($output, $comparison) -or $output.StartsWith("$source$separator", $comparison) -or $source.StartsWith("$output$separator", $comparison)) {
                    throw "输出目录与已有容器的可写数据挂载重叠（包括已停止容器），请另选独立目录。"
                }
            }
        }
    }
    $startedContainers = @()
    assertOutputUnmapped
    $images = @{}
    foreach ($stage in @("candidate", "rollback")) {
        $reference = if ($stage -eq "candidate") { $candidateImage } else { $rollbackImage }
        if ($reference -notmatch '^[a-zA-Z0-9][a-zA-Z0-9._:/@-]*$') { throw "镜像引用格式无效。" }
        $id = (& $dockerCommand --host $endpoint image inspect $reference --format '{{.Id}}' | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or $id -notmatch '^sha256:[a-f0-9]{64}$') { throw "$stage 镜像必须预先存在本机；本脚本不会 build 或 pull。" }
        $images[$stage] = $id
    }
    $batch = "$(Get-Date -Format yyyyMMddHHmmss)-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
    $names = @{ candidate = "toonflow-drill-candidate-$batch"; rollback = "toonflow-drill-rollback-$batch" }
    $copies = @{ candidate = (Join-Path $output "candidateData"); rollback = (Join-Path $output "rollbackData") }
    # 运行时协议门禁只操作全新合成目录，绝不把探针写入备份或恢复副本。
    $protocolProbe = @'
import { mkdir, readFile, writeAtomic, existsSync } from "@toonflow/file";
import { createHash } from "node:crypto";
const phase = process.argv[1], base = "http://127.0.0.1:3000", directory = "/app/data/workspaces/protocolProbe";
const receiptPath = "/app/data/protocolProbe.json";
let headers = { origin: base, "accept-language": "zh-CN", "content-type": "application/json", "x-toonflow-workspace": "1" };
async function request(path, body, status = 200) {
  const response = await fetch(base + path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  if (response.status !== status) throw new Error(`${path}: HTTP ${response.status}, expected ${status}`);
  const result = await response.json();
  if (result.code !== status) throw new Error(`${path}: invalid response code`);
  return { result, response };
}
try {
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try { if ((await fetch(base + "/api/auth/status", { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
    await Bun.sleep(500);
  }
  if (!ready || (await request("/api/auth/status")).result.data?.required !== true) throw new Error("Isolated authentication did not become ready");
  const login = await request("/api/auth/login", { username: "protocolProbe", password: process.env.TOONFLOW_ADMIN_PASSWORD });
  const actorId = login.result.data?.user?.id, cookie = login.response.headers.get("set-cookie")?.split(";")[0];
  if (!cookie || typeof actorId !== "string" || login.result.data?.user?.role !== "admin") throw new Error("Isolated administrator login failed");
  headers = { ...headers, cookie, "x-toonflow-user-id": actorId };
  let receipt;
  if (phase === "prepare") {
    await mkdir(directory, { recursive: true });
    const project = (await request("/api/projects/register", { directory, name: "Submission protocol compatibility" })).result.data;
    if (typeof project?.id !== "string") throw new Error("Project registration failed");
    receipt = { projectId: project.id, requestId: crypto.randomUUID(), actorId };
  } else if (phase === "verify") {
    receipt = JSON.parse(await readFile(receiptPath, "utf8"));
    if (receipt.actorId !== actorId) throw new Error("Administrator identity changed after restart");
  } else throw new Error("Unknown protocol phase");
  headers["x-toonflow-project-id"] = receipt.projectId;
  const taskPath = `/app/data/mediaTasks/${createHash("sha256").update(directory).digest("hex")}/${receipt.requestId}.json`;
  const markerPath = taskPath.slice(0, -5) + ".submission.json";
  const markerHash = async () => createHash("sha256").update(await readFile(markerPath)).digest("hex");
  if (existsSync(taskPath) || phase === "verify" && await markerHash() !== receipt.markerHash) throw new Error("Persisted closed marker or task state changed");
  const resolved = (await request("/api/ai/media/tasks/resolveSubmission", { directory, requestId: receipt.requestId })).result.data;
  if (resolved?.state !== "closed" || resolved.requestId !== receipt.requestId || resolved.projectId !== receipt.projectId || resolved.actorId !== actorId) throw new Error("Closed submission identity was not confirmed");
  if (phase === "prepare") {
    receipt.markerHash = await markerHash();
    await writeAtomic(receiptPath, JSON.stringify(receipt), { exclusive: true, mode: 0o600 });
  } else {
    const late = (await request("/api/ai/media/tasks/create", { directory, requestId: receipt.requestId, mediaType: "video", providerId: "protocolProbeMissing", modelId: "protocolProbeMissing", prompt: "Isolated protocol compatibility", mode: "text", duration: 4, resolution: "720p", ratio: "16:9", generateAudio: false }, 409)).result;
    if (late.message !== "此提交请求已关闭，请使用新的请求 ID") throw new Error("Late submission was not rejected specifically as closed");
  }
  if (existsSync(taskPath) || await markerHash() !== receipt.markerHash) throw new Error("Closed request created a task or changed its marker");
  console.log(JSON.stringify({ protocol: "submissionClose", version: 1, phase, status: "passed", requestId: receipt.requestId, markerHash: receipt.markerHash, taskCreated: false, lateCreateStatus: phase === "verify" ? 409 : null }));
} catch (error) {
  console.log(JSON.stringify({ protocol: "submissionClose", version: 1, phase, status: "rejected", reason: error instanceof Error ? error.message : "Unknown protocol failure" }));
  process.exitCode = 1;
}
'@
    function confirmSubmissionProtocol([string]$stage) {
        $probeDirectory = Join-Path $output "${stage}ProtocolData"
        New-Item -ItemType Directory -Path $probeDirectory | Out-Null
        $previousAdminPassword = $env:TOONFLOW_ADMIN_PASSWORD
        try {
            $env:TOONFLOW_ADMIN_PASSWORD = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")
            assertDockerTarget
            $id = (& $dockerCommand --host $endpoint run --pull never -d --name "toonflow-drill-$stage-protocol-$batch" --network none --mount "type=bind,source=$probeDirectory,target=/app/data" --env TOONFLOW_DATA_DIR=/app/data --env TOONFLOW_AUTH_REQUIRED=true --env TOONFLOW_ADMIN_USERNAME=protocolProbe --env TOONFLOW_ADMIN_PASSWORD $images[$stage] | Out-String).Trim()
            if ($LASTEXITCODE -ne 0 -or $id -notmatch '^[a-f0-9]{64}$') { throw "$stage 无法启动独立协议门禁；未恢复备份。" }
            $script:startedContainers += @{ id = $id; stage = "${stage}Protocol" }
        } finally { $env:TOONFLOW_ADMIN_PASSWORD = $previousAdminPassword }
        $preparedResult = $null
        foreach ($phase in @("prepare", "verify")) {
            assertDockerTarget
            $probeOutput = @(& $dockerCommand --host $endpoint exec $id bun -e $protocolProbe $phase 2>&1)
            $probeExit = $LASTEXITCODE
            $probeOutput | Out-File -LiteralPath (Join-Path $output "${stage}Protocol${phase}.log") -Encoding utf8
            if ($probeExit -ne 0 -or $probeOutput.Count -ne 1) { throw "$stage 提交关闭协议门禁失败或未知（$phase）；未恢复备份，不能作为安全回滚目标。" }
            try { $result = $probeOutput[0] | ConvertFrom-Json } catch { throw "$stage 协议门禁结果无法解析；未恢复备份。" }
            $fields = @("protocol", "version", "phase", "status", "requestId", "markerHash", "taskCreated", "lateCreateStatus")
            if ($result -isnot [pscustomobject] -or @($result.PSObject.Properties).Count -ne $fields.Count -or @($fields | Where-Object { $_ -cnotin $result.PSObject.Properties.Name }).Count -or
                $result.protocol -isnot [string] -or $result.protocol -cne "submissionClose" -or ($result.version -isnot [int] -and $result.version -isnot [long]) -or $result.version -ne 1 -or
                $result.phase -isnot [string] -or $result.phase -cne $phase -or $result.status -isnot [string] -or $result.status -cne "passed" -or
                $result.requestId -isnot [string] -or $result.requestId -cnotmatch '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' -or
                $result.markerHash -isnot [string] -or $result.markerHash -cnotmatch '^[a-f0-9]{64}$' -or $result.taskCreated -isnot [bool] -or $result.taskCreated -ne $false -or
                ($phase -eq "prepare" -and $null -ne $result.lateCreateStatus) -or
                ($phase -eq "verify" -and (($result.lateCreateStatus -isnot [int] -and $result.lateCreateStatus -isnot [long]) -or $result.lateCreateStatus -ne 409 -or $result.requestId -cne $preparedResult.requestId -or $result.markerHash -cne $preparedResult.markerHash))) {
                throw "$stage 协议门禁结果不完整或类型无效；未恢复备份。"
            }
            if ($phase -eq "prepare") {
                $preparedResult = $result
                assertDockerTarget
                & $dockerCommand --host $endpoint stop $id | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "$stage 协议容器停止失败，不能确认重启持久性。" }
                & $dockerCommand --host $endpoint start $id | Out-Null
                if ($LASTEXITCODE -ne 0) { throw "$stage 协议容器重启失败。" }
            }
        }
        assertDockerTarget
        & $dockerCommand --host $endpoint stop $id | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "$stage 协议容器停止未确认。" }
        @{ image = $images[$stage]; container = $id; protocol = "submissionClose"; status = "passed"; restartVerified = $true; lateCreateStatus = 409 } | ConvertTo-Json | Out-File -LiteralPath (Join-Path $output "${stage}Protocol.json") -Encoding utf8
        Write-Output "$stage 提交关闭协议门禁通过（含重启持久性及迟到提交拒绝）；不代表全部升级或回滚兼容。"
    }
    Write-Output "隔离演练计划：context=$context；endpoint=$endpoint；备份=$backup；输出=$output"
    foreach ($stage in @("candidate", "rollback")) { Write-Output "${stage}：镜像=$($images[$stage])；副本=$($copies[$stage])；容器=$($names[$stage])" }
    Write-Output "两个版本分别使用同一备份的独立恢复副本，network=none，不映射端口。备份解密完整性及原运行路径将在 Execute 阶段验证。"
    Write-Output "Execute 先在两个全新合成目录验证提交关闭协议、重启持久性与迟到提交拒绝；两镜像均通过后才解密备份。404、未知或错误均拒绝，不能跳过。"
    Write-Warning "协议门禁通过仅是必要条件，不证明完整业务回滚安全；禁止据此直接把升级后的数据交给旧版本。"
    if (-not $execute) { Write-Output "只读计划结束；未恢复数据或创建容器。"; return }

    $previousPassword = $env:TOONFLOW_BACKUP_PASSWORD
    $secret = $null
    $credential = $null
    $stopFailures = @()
    $failure = $null
    try {
        assertOutputUnmapped -verifyMappings
        New-Item -ItemType Directory -Path $output | Out-Null
        foreach ($stage in @("candidate", "rollback")) { confirmSubmissionProtocol $stage }
        $secret = Read-Host "请输入现有备份密码（仅本机恢复进程使用）" -AsSecureString
        $credential = New-Object System.Net.NetworkCredential("", $secret)
        if ($credential.Password.Length -lt 16) { throw "备份密码至少 16 个字符。" }
        assertOutputUnmapped -verifyMappings
        $env:TOONFLOW_BACKUP_PASSWORD = $credential.Password
        $credential = $null
        foreach ($stage in @("candidate", "rollback")) {
            # 复用已有恢复工具校验解密与文件大小、哈希，不新增业务探针。
            $restoreOutput = @(& $bunCommand $backupScript restore $backup $copies[$stage] --offline-confirmed 2>&1)
            $restoreCode = $LASTEXITCODE
            $restoreOutput | Out-File -LiteralPath (Join-Path $output "${stage}Restore.log") -Encoding utf8
            if ($restoreCode -ne 0) { throw "$stage 恢复失败；保留部分副本和日志，不启动应用。" }
            if ($restoreOutput.Count -ne 1 -or [string]$restoreOutput[0] -cnotmatch '^Restore verified: [0-9]+ files\. Original runtime path: /app/data\. Keep the same runtime path when mounting; project/task paths are not migrated\.$') {
                throw "备份原运行路径未确认为 /app/data；不能自动迁移项目路径，保留副本但不启动。"
            }
        }
        $env:TOONFLOW_BACKUP_PASSWORD = $previousPassword
        foreach ($stage in @("candidate", "rollback")) {
            $name = $names[$stage]
            assertOutputUnmapped -verifyMappings
            $containerId = (& $dockerCommand --host $endpoint run --pull never -d --name $name --network none --mount "type=bind,source=$($copies[$stage]),target=/app/data" --env TOONFLOW_DATA_DIR=/app/data $images[$stage] | Out-String).Trim()
            if ($LASTEXITCODE -ne 0 -or $containerId -notmatch '^[a-f0-9]{64}$') { throw "$stage 容器启动失败；保留副本及可能已创建的容器，不操作同名已有容器。" }
            $startedContainers += @{ id = $containerId; stage = $stage }
            $observed = $false
            for ($attempt = 0; $attempt -lt 30; $attempt++) {
                assertDockerTarget
                $stateJson = & $dockerCommand --host $endpoint inspect $containerId --format '{{json .State}}'
                if ($LASTEXITCODE -ne 0) { throw "无法读取 $stage 容器状态。" }
                $stateJson | Out-File -LiteralPath (Join-Path $output "${stage}State.json") -Encoding utf8
                $state = $stateJson | ConvertFrom-Json
                if (-not $state.Running) { throw "$stage 进程已经退出；查看保留的容器日志。" }
                if (-not $state.Health) {
                    Write-Warning "$stage 镜像未定义健康检查；仅观察到容器进程运行，业务就绪未验证。"
                    $observed = $true
                    break
                }
                if ($state.Health.Status -eq "unhealthy") { throw "$stage 镜像已有健康检查报告异常。" }
                if ($state.Health.Status -eq "healthy") { $observed = $true; break }
                Start-Sleep -Seconds 1
            }
            if (-not $observed) { throw "$stage 已有健康检查未在观察期内就绪。" }
            assertDockerTarget
            & $dockerCommand --host $endpoint stop $containerId
            if ($LASTEXITCODE -ne 0) { throw "无法停止隔离容器 $containerId；停止后续阶段并人工检查。" }
            Write-Output "$stage 隔离启动观察结束，容器与数据副本已保留。"
        }
        Write-Output "两个独立副本的恢复与启动观察结束；不代表登录、生成、费用、迁移兼容或完整业务回滚通过。"
    } catch { $failure = $_ } finally {
        $env:TOONFLOW_BACKUP_PASSWORD = $previousPassword
        $credential = $null
        if ($secret) { $secret.Dispose() }
        foreach ($container in $startedContainers) {
            try {
                assertDockerTarget
                & $dockerCommand --host $endpoint logs --timestamps $container.id 2>&1 | Out-File -LiteralPath (Join-Path $output "$($container.stage)Container.log") -Encoding utf8
                if ($LASTEXITCODE -ne 0) { Write-Warning "无法导出容器日志，请保留并人工查看：$($container.id)" }
            } catch { Write-Warning "日志导出失败，容器内日志仍保留：$($container.id)" }
            try {
                assertDockerTarget
                & $dockerCommand --host $endpoint stop $container.id
                if ($LASTEXITCODE -ne 0) { $stopFailures += $container.id }
            } catch { $stopFailures += $container.id }
        }
    }


    if ($stopFailures.Count) { throw "隔离容器停止未确认：$($stopFailures -join ', ')；原执行错误：$failure" }
    if ($failure) { throw $failure }
} finally { $env:DOCKER_CONTEXT = $previousContext }
