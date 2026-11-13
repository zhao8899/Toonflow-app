param(
    [string]$containerName,
    [string]$backupRoot,
    [string]$dockerContext,
    [switch]$execute
)
$ErrorActionPreference = "Stop"
if ([string]::IsNullOrWhiteSpace($containerName) -or [string]::IsNullOrWhiteSpace($backupRoot)) {
    throw "用法：./dockerRecovery.ps1 -ContainerName 容器名 -BackupRoot 已存在的本地绝对目录 [-DockerContext 本地上下文] [-Execute]。默认仅查看计划；Execute 会短暂停止该容器。"
}
if ($containerName -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$') { throw "容器名称或 ID 无效。" }
if ($env:DOCKER_HOST) { throw "请先明确清除 DOCKER_HOST，再用 DockerContext 选择本地引擎，避免目标歧义。" }

function resolveLocalDirectory([string]$path) {
    if (-not [IO.Path]::IsPathFullyQualified($path) -or $path.StartsWith("\\") -or $path.StartsWith("//") -or $path.Contains(",")) {
        throw "目录必须是本地绝对路径，不能是网络路径或包含逗号：$path"
    }
    $item = Get-Item -LiteralPath $path
    if (-not $item.PSIsContainer -or $item.PSProvider.Name -ne "FileSystem") { throw "目录不存在或不是文件系统目录：$path" }
    if ($IsWindows -and ([IO.DriveInfo]::new([IO.Path]::GetPathRoot($item.FullName))).DriveType -eq [IO.DriveType]::Network) { throw "不支持映射网络驱动器：$path" }
    for ($parent = $item; $null -ne $parent; $parent = $parent.Parent) {
        if ($parent.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "不支持链接或重解析目录：$path" }
    }
    return $item.FullName
}
function confirmSeparateDirectory([string]$source) {
    # 仅比较主机原生绝对路径，不把 Docker VM 的路径猜测映射到主机。
    if (-not [IO.Path]::IsPathFullyQualified($source)) { return }
    $sourcePrefix = [IO.Path]::GetFullPath($source).Replace("\", "/").TrimEnd("/") + "/"
    $backupPrefix = $backupRoot.Replace("\", "/").TrimEnd("/") + "/"
    $comparison = if ($IsWindows) { [StringComparison]::OrdinalIgnoreCase } else { [StringComparison]::Ordinal }
    if ($sourcePrefix.StartsWith($backupPrefix, $comparison) -or $backupPrefix.StartsWith($sourcePrefix, $comparison)) {
        throw "备份目录和数据目录不能相同或互相包含。"
    }
}

$backupRoot = resolveLocalDirectory $backupRoot
$backupScript = Join-Path $PSScriptRoot "dataBackup.ts"
if ($backupScript.Contains(",") -or -not (Test-Path -LiteralPath $backupScript -PathType Leaf)) { throw "备份工具路径无效。" }
$dockerPath = (Get-Command docker -CommandType Application | Select-Object -First 1).Source
if ([string]::IsNullOrWhiteSpace($dockerContext)) {
    $dockerContext = & $dockerPath context show
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($dockerContext)) { throw "无法确定 Docker 上下文。" }
}
function readEndpoint {
    $value = & $dockerPath context inspect $dockerContext --format '{{.Endpoints.docker.Host}}'
    if ($LASTEXITCODE -ne 0 -or @($value).Count -ne 1) { throw "无法读取指定 Docker 上下文。" }
    return [string]$value
}
$endpoint = readEndpoint
if ($endpoint -notmatch '^npipe:/{2,4}\./pipe/[a-zA-Z0-9_.-]+$' -and $endpoint -notmatch '^unix:///[^\r\n]+$') {
    throw "仅支持本机 named pipe 或 Unix socket；拒绝远程 Docker endpoint。"
}
function invokeDocker([string[]]$arguments) {
    $originalContext = [Environment]::GetEnvironmentVariable("DOCKER_CONTEXT", "Process")
    try {
        Remove-Item Env:DOCKER_CONTEXT -ErrorAction SilentlyContinue
        $output = & $dockerPath --host $endpoint @arguments
        if ($LASTEXITCODE -ne 0) { throw "Docker 操作失败：$($arguments[0]) $($arguments[1])。未继续下一步。" }
        return $output
    } finally {
        if ($null -eq $originalContext) { Remove-Item Env:DOCKER_CONTEXT -ErrorAction SilentlyContinue }
        else { [Environment]::SetEnvironmentVariable("DOCKER_CONTEXT", $originalContext, "Process") }
    }
}
function readTarget([string]$identity) {
    $fields = (invokeDocker @("container", "inspect", $identity, "--format", '{{.Id}}|{{.Image}}|{{.State.Running}}')) -split '\|'
    if ($fields.Count -ne 3 -or $fields[0] -notmatch '^[a-f0-9]{64}$' -or $fields[1] -notmatch '^sha256:[a-f0-9]{64}$') {
        throw "目标容器身份无效。"
    }
    $mounts = invokeDocker @("container", "inspect", $fields[0], "--format", '{{json .Mounts}}')
    return [pscustomobject]@{ id = $fields[0]; image = $fields[1]; running = $fields[2] -eq "true"; mounts = [string]$mounts }
}

$daemonId = invokeDocker @("info", "--format", '{{.ID}}')
if ([string]::IsNullOrWhiteSpace($daemonId)) { throw "无法确认本机 Docker 引擎身份。" }
$target = readTarget $containerName
if (-not $target.running) { throw "目标容器未运行；请先人工确认其状态。" }
$dataDirectory = @(invokeDocker @("container", "inspect", $target.id, "--format", '{{range .Config.Env}}{{if eq (index (split . "=") 0) "TOONFLOW_DATA_DIR"}}{{println .}}{{end}}{{end}}') | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
if ($dataDirectory.Count -gt 1 -or ($dataDirectory.Count -eq 1 -and $dataDirectory[0] -cne "TOONFLOW_DATA_DIR=/app/data")) {
    throw "目标容器显式数据目录不是 /app/data 或配置重复；不能按当前工具备份。"
}
$mounts = @($target.mounts | ConvertFrom-Json)
$dataMounts = @($mounts | Where-Object { $_.Destination -ceq "/app/data" })
if ($dataMounts.Count -ne 1 -or @($mounts | Where-Object { $_.Destination.StartsWith("/app/data/") }).Count) {
    throw "需要唯一的 /app/data 挂载，且不能存在其下的嵌套挂载。"
}
$dataMount = $dataMounts[0]
if ($dataMount.Type -eq "volume") {
    if ($dataMount.Name -notmatch '^[a-zA-Z0-9][a-zA-Z0-9_.-]*$') { throw "数据卷名称无效。" }
    $volume = invokeDocker @("volume", "inspect", $dataMount.Name, "--format", '{{.Driver}}|{{.Scope}}|{{json .Options}}')
    if ($volume -notmatch '^local\|local\|(null|\{\})$') { throw "仅支持无额外驱动选项的本地数据卷。" }
    confirmSeparateDirectory $dataMount.Source
    $dataMountArgument = "type=volume,source=$($dataMount.Name),target=/app/data,readonly"
} elseif ($dataMount.Type -eq "bind") {
    # Docker VM 路径不能猜测为 Windows 主机路径；仅接受主机可直接校验的目录。
    $dataSource = resolveLocalDirectory $dataMount.Source
    confirmSeparateDirectory $dataSource
    $dataMountArgument = "type=bind,source=$($dataMount.Source),target=/app/data,readonly"
} else { throw "仅支持明确的 volume 或 bind 数据挂载。" }
$image = invokeDocker @("image", "inspect", $target.image, "--format", '{{.Id}}')
if ($image -ne $target.image) { throw "目标容器的不可变镜像不可用。" }

function confirmTarget([string]$state) {
    if ((readEndpoint) -ne $endpoint -or (invokeDocker @("info", "--format", '{{.ID}}')) -ne $daemonId) { throw "Docker 上下文或引擎已变化，停止操作。" }
    $current = readTarget $containerName
    if ($current.id -ne $target.id -or $current.image -ne $target.image -or $current.mounts -ne $target.mounts) {
        throw "容器身份或挂载已变化，停止操作。"
    }
    if (($state -eq "running" -and -not $current.running) -or ($state -eq "stopped" -and $current.running)) { throw "容器运行状态已变化，停止操作。" }
}
function confirmNoOtherWriters {
    foreach ($id in @(invokeDocker @("ps", "--quiet", "--no-trunc"))) {
        if ($id -eq $target.id) { continue }
        $others = @(invokeDocker @("container", "inspect", $id, "--format", '{{json .Mounts}}') | ConvertFrom-Json)
        foreach ($mount in $others) {
            if (-not $mount.RW) { continue }
            $sameVolume = $dataMount.Type -eq "volume" -and $mount.Type -eq "volume" -and $mount.Name -eq $dataMount.Name
            $source = ([string]$dataMount.Source).Replace("\", "/").TrimEnd("/") + "/"
            $otherSource = ([string]$mount.Source).Replace("\", "/").TrimEnd("/") + "/"
            if ($sameVolume -or $source.StartsWith($otherSource, [StringComparison]::OrdinalIgnoreCase) -or $otherSource.StartsWith($source, [StringComparison]::OrdinalIgnoreCase)) {
                throw "另一个运行中容器可能写入同一数据：$id。请先人工停止其他写入者。"
            }
        }
    }
}
confirmNoOtherWriters

$batch = (Get-Date -Format yyyyMMddHHmmssfff) + [guid]::NewGuid().ToString("N").Substring(0, 8)
$backupDirectory = Join-Path $backupRoot "backup$batch"
$restoreDirectory = Join-Path $backupRoot "restored$batch"
Write-Output "本地备份恢复计划：context=$dockerContext；endpoint=$endpoint"
Write-Output "容器：$containerName；ID：$($target.id)；镜像：$image"
Write-Output "数据挂载：$dataMountArgument"
Write-Output "加密备份：$backupDirectory；恢复副本：$restoreDirectory"
Write-Output "只验证文件恢复，不切换原数据、不启动恢复副本。失败副本保留。已检查运行中容器的共享挂载；宿主进程等其他写入者仍须人工停止并核对上游任务。数据目录外未登记工作区不在备份内。"
if (-not $execute) { Write-Output "只读计划结束。确认后以相同参数加 -Execute 执行。"; return }

$stopAttempted = $false
$secret = $null
$credential = $null
$originalPassword = [Environment]::GetEnvironmentVariable("TOONFLOW_BACKUP_PASSWORD", "Process")
try {
    confirmTarget "running"
    $secret = Read-Host "请输入备份密码（至少16字符，并在密码管理器中保存）" -AsSecureString
    $credential = New-Object System.Net.NetworkCredential("", $secret)
    if ($credential.Password.Length -lt 16) { throw "密码少于16字符；尚未停止容器。" }
    $env:TOONFLOW_BACKUP_PASSWORD = $credential.Password
    $credential = $null
    confirmTarget "running"
    invokeDocker @("run", "--pull", "never", "--rm", "--network", "none", "--entrypoint", "bun", "--workdir", "/app", "--env", "TOONFLOW_BACKUP_PASSWORD", $image, "-e", 'if (!process.env.TOONFLOW_BACKUP_PASSWORD || process.env.TOONFLOW_BACKUP_PASSWORD.length < 16) process.exit(1);') | Out-Null
    confirmTarget "running"
    confirmNoOtherWriters
    $stopAttempted = $true
    invokeDocker @("stop", $target.id) | Out-Null
    confirmTarget "stopped"
    confirmNoOtherWriters
    invokeDocker @("run", "--pull", "never", "--rm", "--network", "none", "--entrypoint", "bun", "--workdir", "/app", "--env", "TOONFLOW_BACKUP_PASSWORD",
        "--mount", $dataMountArgument, "--mount", "type=bind,source=$backupRoot,target=/recovery",
        "--mount", "type=bind,source=$backupScript,target=/app/apps/server/scripts/dataBackup.ts,readonly",
        $image, "apps/server/scripts/dataBackup.ts", "backup", "/app/data", "/recovery/backup$batch", "--offline-confirmed")
    confirmTarget "stopped"
    invokeDocker @("run", "--pull", "never", "--rm", "--network", "none", "--entrypoint", "bun", "--workdir", "/app", "--env", "TOONFLOW_BACKUP_PASSWORD",
        "--mount", "type=bind,source=$backupRoot,target=/recovery",
        "--mount", "type=bind,source=$backupScript,target=/app/apps/server/scripts/dataBackup.ts,readonly",
        $image, "apps/server/scripts/dataBackup.ts", "restore", "/recovery/backup$batch", "/recovery/restored$batch", "--offline-confirmed")
} finally {
    if ($null -eq $originalPassword) { Remove-Item Env:TOONFLOW_BACKUP_PASSWORD -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable("TOONFLOW_BACKUP_PASSWORD", $originalPassword, "Process") }
    $credential = $null
    if ($secret) { $secret.Dispose() }
    if ($stopAttempted) {
        try {
            confirmTarget "any"
            if (-not (readTarget $target.id).running) { invokeDocker @("start", $target.id) | Out-Null }
            confirmTarget "running"
        } catch { throw "原容器未确认恢复运行：$($target.id)。请人工检查并恢复；所有备份及恢复副本已保留。原因：$($_.Exception.Message)" }
    }
}
Write-Output "备份和恢复文件校验完成，原容器已确认运行。备份：$backupDirectory；恢复副本：$restoreDirectory。尚未验证恢复副本业务。"
