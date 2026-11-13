import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeAtomicSync } from "@toonflow/file";

const powershell = Bun.which("pwsh");
const recoveryScript = resolve(import.meta.dirname, "../scripts/dockerRecovery.ps1");
const upgradeScript = resolve(import.meta.dirname, "../scripts/dockerUpgrade.ps1");
const containerId = "a".repeat(64);
const imageId = `sha256:${"b".repeat(64)}`;

function runRecovery(failure: "none" | "restart" | "backup" | "stop", options: {
  execute?: boolean;
  invalid?: "missing" | "container" | "directory" | "dockerHost" | "endpoint";
  existingPassword?: string;
  contextAbsent?: boolean;
} = {}) {
  if (!powershell) throw new Error("PowerShell is required for this regression test.");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "toonflowDockerRecovery")));
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const endpoint = options.invalid === "endpoint" ? "tcp://remote.example:2375" : "npipe:////./pipe/isolatedDockerEngine";
  const parameters = options.invalid === "missing" ? "" : `$parameters.ContainerName = ${quote(options.invalid === "container" ? "invalid/name" : "isolatedContainer")}\n$parameters.BackupRoot = ${quote(options.invalid === "directory" ? "relativeBackup" : root)}`;
  const command = `
$ErrorActionPreference = "Stop"
$global:isolatedRunning = $true
$expectedPassword = [Environment]::GetEnvironmentVariable("TOONFLOW_BACKUP_PASSWORD", "Process")
$expectedContext = [Environment]::GetEnvironmentVariable("DOCKER_CONTEXT", "Process")
function Read-Host {
  [Console]::Error.WriteLine("passwordPrompt")
  ConvertTo-SecureString "isolatedRegressionPassword" -AsPlainText -Force
}
function Get-Command {
  param([string]$Name, [string]$CommandType)
  if ($Name -cne "docker" -or $CommandType -cne "Application") { throw "Unexpected command discovery" }
  [pscustomobject]@{ Source = "invokeIsolatedDocker" }
  [pscustomobject]@{ Source = "rejectSecondDockerCandidate" }
}
function rejectSecondDockerCandidate { throw "Must select only the first Application candidate" }
function invokeIsolatedDocker {
  $global:LASTEXITCODE = 0
  $callArgs = @($args)
  if ($callArgs[0] -eq "--host") {
    if ($callArgs[1] -cne "npipe:////./pipe/isolatedDockerEngine") { throw "Unexpected pinned endpoint" }
    if ([Environment]::GetEnvironmentVariable("DOCKER_CONTEXT", "Process")) { throw "Inherited Docker context was not isolated" }
    $callArgs = @($callArgs | Select-Object -Skip 2)
  } elseif ($callArgs[0] -ne "context") { throw "Docker operation omitted explicit endpoint" }
  [Console]::Error.WriteLine("docker:" + ($callArgs -join " "))
  switch ($callArgs[0]) {
    "context" {
      if ($callArgs[1] -eq "show") { "isolatedContext"; return }
      if ($callArgs[1] -eq "inspect" -and $callArgs[2] -eq "isolatedContext") { "${endpoint}"; return }
      throw "Unexpected context lookup"
    }
    "info" { "isolatedDaemon"; return }
    "container" {
      if ($callArgs[1] -ne "inspect" -or $callArgs[2] -notin @("isolatedContainer", "${containerId}")) { throw "Unexpected container identity" }
      if ($callArgs[-1] -eq '{{.Id}}|{{.Image}}|{{.State.Running}}') {
        "${containerId}|${imageId}|" + $global:isolatedRunning.ToString().ToLowerInvariant(); return
      }
      if ($callArgs[-1] -eq '{{json .Mounts}}') {
        '[{"Type":"volume","Name":"isolatedData","Source":"/var/lib/docker/volumes/isolatedData/_data","Destination":"/app/data","RW":true}]'; return
      }
      if ($callArgs[-1] -like '*TOONFLOW_DATA_DIR*') { "TOONFLOW_DATA_DIR=/app/data"; return }
      throw "Unexpected inspect format"
    }
    "volume" { "local|local|null"; return }
    "image" {
      if ($callArgs[1] -ne "inspect" -or $callArgs[2] -cne "${imageId}") { throw "Unexpected image lookup" }
      "${imageId}"; return
    }
    "ps" { if ($global:isolatedRunning) { "${containerId}" }; return }
    "stop" {
      if ($callArgs[1] -cne "${containerId}") { throw "Stop did not use immutable ID" }
      $global:isolatedRunning = $false
      if ("${failure}" -eq "stop") { $global:LASTEXITCODE = 1 }
      return
    }
    "start" {
      if ($callArgs[1] -cne "${containerId}") { throw "Start did not use immutable ID" }
      if ("${failure}" -eq "restart") { $global:LASTEXITCODE = 1; return }
      $global:isolatedRunning = $true; return
    }
    "run" {
      if ($callArgs -notcontains "${imageId}" -or $callArgs -notcontains "none" -or $callArgs -notcontains "never") { throw "Helper did not pin image and disable network/pull" }
      if ($callArgs -contains "backup" -or $callArgs -contains "restore") {
        if ($global:isolatedRunning) { throw "Backup or restore ran while original writer was running" }
      }
      if ("${failure}" -eq "backup" -and $callArgs -contains "backup") { $global:LASTEXITCODE = 1 }
      return
    }
    default { throw "Unexpected Docker operation" }
  }
}
$parameters = @{}
${parameters}
${options.execute === false ? "" : "$parameters.Execute = $true"}
$scriptFailed = $false
try {
  & ${quote(recoveryScript)} @parameters
} catch {
  $scriptFailed = $true
  [Console]::Error.WriteLine("scriptError:" + $_.Exception.Message)
} finally {
  if ([Environment]::GetEnvironmentVariable("TOONFLOW_BACKUP_PASSWORD", "Process") -cne $expectedPassword) { throw "Backup password environment was not restored" }
  if ([Environment]::GetEnvironmentVariable("DOCKER_CONTEXT", "Process") -cne $expectedContext) { throw "Docker context environment was not restored" }
  [Console]::Error.WriteLine("environmentRestored")
  [Console]::Error.WriteLine("finalRunning:" + $global:isolatedRunning.ToString().ToLowerInvariant())
}
if ($scriptFailed) { exit 1 }
`;
  try {
    // Only command discovery is intercepted; the real script retains all input and identity checks.
    // No executable search path is available, so an accidental real Docker invocation cannot run.
    const result = Bun.spawnSync([powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      env: { ...process.env, PATH: "", DOCKER_HOST: options.invalid === "dockerHost" ? "tcp://remote.example:2375" : undefined,
        DOCKER_CONTEXT: options.contextAbsent ? undefined : "inheritedContext", TOONFLOW_BACKUP_PASSWORD: options.existingPassword },
      timeout: 15000,
    });
    return { exitCode: result.exitCode, stderr: result.stderr.toString(), stdout: result.stdout.toString(), files: readdirSync(root) };
  } finally {
    const actual = realpathSync(root);
    if (actual !== root || dirname(actual) !== realpathSync(tmpdir()) || !basename(actual).startsWith("toonflowDockerRecovery")) {
      throw new Error("拒绝清理不属于本次测试的目录");
    }
    rmSync(actual, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== "win32")("Docker recovery explicit execution contract", () => {
  test("successful backup and restore restart the original immutable container and clear the temporary password", () => {
    const result = runRecovery("none");
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(`docker:stop ${containerId}`);
    expect(result.stderr).toContain(`docker:start ${containerId}`);
    expect(result.stderr).toContain("dataBackup.ts backup");
    expect(result.stderr).toContain("dataBackup.ts restore");
    expect(result.stderr).toContain("environmentRestored");
    expect(result.stderr).toContain("finalRunning:true");
    expect(result.stdout).toContain("原容器已确认运行");
    expect(result.stderr.indexOf("dataBackup.ts restore")).toBeLessThan(result.stderr.indexOf(`docker:start ${containerId}`));
  });

  test("restart failure fails the recovery command and preserves the original environment", () => {
    const result = runRecovery("restart", { existingPassword: "originalBackupPassword" });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("原容器未确认恢复运行");
    expect(result.stderr).toContain("environmentRestored");
    expect(result.stderr).toContain("finalRunning:false");
    expect(result.stdout).not.toContain("原容器已确认运行");
  });

  test("backup failure still restarts the original service without attempting restore", () => {
    const result = runRecovery("backup");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Docker 操作失败：run --pull");
    expect(result.stderr).toContain(`docker:start ${containerId}`);
    expect(result.stderr).not.toContain("dataBackup.ts restore");
    expect(result.stderr).toContain("environmentRestored");
    expect(result.stderr).toContain("finalRunning:true");
  });

  test("stop error after the container stopped still restarts the original ID and fails the command", () => {
    const result = runRecovery("stop");
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(`Docker 操作失败：stop ${containerId}`);
    expect(result.stderr).toContain(`docker:start ${containerId}`);
    expect(result.stderr).not.toContain("dataBackup.ts backup");
    expect(result.stderr).not.toContain("dataBackup.ts restore");
    expect(result.stderr).toContain("environmentRestored");
    expect(result.stderr).toContain("finalRunning:true");
    expect(result.stdout).not.toContain("原容器已确认运行");
  });

  test("default plan is read-only and does not request a password or create output directories", () => {
    const result = runRecovery("none", { execute: false, existingPassword: "originalBackupPassword" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("只读计划结束");
    expect(result.stderr).not.toMatch(/docker:(run|stop|start)\b/);
    expect(result.stderr).not.toContain("passwordPrompt");
    expect(result.stderr).toContain("environmentRestored");
    expect(result.files).toEqual([]);
  });

  test("execute restores an existing backup password and Docker context", () => {
    const result = runRecovery("none", { existingPassword: "originalBackupPassword" });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("environmentRestored");
    expect(result.stderr).not.toContain("originalBackupPassword");
    expect(result.stderr).not.toContain("isolatedRegressionPassword");
  });

  test("default plan preserves an absent Docker context", () => {
    const result = runRecovery("none", { execute: false, contextAbsent: true });
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("environmentRestored");
    expect(result.stderr).not.toMatch(/docker:(run|stop|start)\b/);
  });

  for (const [invalid, message] of [
    ["missing", "用法"], ["container", "容器名称或 ID 无效"], ["directory", "目录必须是本地绝对路径"],
    ["dockerHost", "清除 DOCKER_HOST"], ["endpoint", "拒绝远程 Docker endpoint"],
  ] as const) {
    test(`rejects ${invalid} before any mutation`, () => {
      const result = runRecovery("none", { invalid });
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toMatch(/docker:(run|stop|start)\b/);
      expect(result.stderr).not.toContain("passwordPrompt");
      expect(result.stderr).toContain("environmentRestored");
      expect(result.files).toEqual([]);
    });
  }
});

function runUpgrade(mapping: "missing" | "candidate" | "caseMismatch" | "overlap", gate?: "supported" | "unsupported" | "unknown" | "verifyFailure" | "restoreFailure" | "invalidTypes" | "changedIdentity") {
  if (!powershell) throw new Error("PowerShell is required for this regression test.");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "toonflowUpgradePlan")));
  const backup = join(root, "backup"), hostData = join(root, "hostData"), output = join(root, "newOutput");
  const source = "/run/desktop/mnt/host/syntheticData";
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  mkdirSync(backup);
  mkdirSync(hostData);
  // This harness checks orchestration only: Docker probe output and restore are isolated substitutes.
  writeAtomicSync(join(backup, "manifest.json"), JSON.stringify({ version: 1, salt: "a".repeat(32), iv: "b".repeat(24), tag: "c".repeat(32), data: "e30=" }));
  const map = mapping === "missing" ? "@{}" : `@{ ${quote(mapping === "caseMismatch" ? source.toUpperCase() : source)} = ${quote(mapping === "overlap" ? root : hostData)} }`;
  const command = `
$ErrorActionPreference = "Stop"
$global:gateStates = @{}
$global:gateRestarts = @{}
function Get-Command {
  param([string]$Name, [string]$CommandType, [string]$ErrorAction)
  if ($CommandType -cne "Application") { throw "Unexpected command type" }
  if ($Name -eq "docker") { [pscustomobject]@{ Source = "invokeIsolatedUpgradeDocker" }; return }
  if ($Name -eq "bun") { [pscustomobject]@{ Source = "invokeIsolatedRestore" }; return }
  throw "Unexpected command discovery"
}
function Read-Host {
  if ("${gate ?? ""}" -eq "") { throw "Plan must not request a password" }
  [Console]::Error.WriteLine("passwordPrompt")
  ConvertTo-SecureString "isolatedRegressionPassword" -AsPlainText -Force
}
function invokeIsolatedRestore {
  if ("${gate ?? ""}" -eq "") { throw "Plan must not invoke restore" }
  if ($args[1] -ne "restore") { throw "Unexpected Bun invocation" }
  [Console]::Error.WriteLine("restore:" + $args[3])
  $global:LASTEXITCODE = 0
  if ("${gate ?? ""}" -eq "restoreFailure") { $global:LASTEXITCODE = 1; return }
  New-Item -ItemType Directory -Path $args[3] | Out-Null
  "Restore verified: 1 files. Original runtime path: /app/data. Keep the same runtime path when mounting; project/task paths are not migrated."
}
function invokeIsolatedUpgradeDocker {
  $global:LASTEXITCODE = 0
  $callArgs = @($args)
  if ($callArgs[0] -eq "--host") {
    if ($callArgs[1] -cne "npipe:////./pipe/isolatedDockerEngine") { throw "Endpoint is not pinned" }
    if ($env:DOCKER_CONTEXT) { throw "Inherited context was not cleared" }
    $callArgs = @($callArgs | Select-Object -Skip 2)
  } elseif ($callArgs[0] -ne "context") { throw "Missing endpoint" }
  if ($callArgs[0] -eq "exec") { [Console]::Error.WriteLine("docker:exec " + $callArgs[1] + " " + $callArgs[-1]) }
  else { [Console]::Error.WriteLine("docker:" + ($callArgs -join " ")) }
  switch ($callArgs[0]) {
    "context" {
      if ($callArgs[1] -eq "show") { "isolatedContext"; return }
      if ($callArgs[1] -eq "inspect") { "npipe:////./pipe/isolatedDockerEngine"; return }
      throw "Unexpected context operation"
    }
    "info" { if ($callArgs[-1] -eq '{{.OSType}}') { "linux" } else { "isolatedDaemon" }; return }
    "ps" {
      if ($callArgs -notcontains "--all") { throw "Stopped historical containers must be included" }
      if ("${gate ?? ""}" -ne "") { $global:gateStates.Keys; return }
      "${containerId}"; return
    }
    "inspect" {
      if ($global:gateStates.ContainsKey($callArgs[1]) -and $callArgs[-1] -eq '{{json .State}}') {
        @{ Running = $global:gateStates[$callArgs[1]] } | ConvertTo-Json -Compress; return
      }
      if ($callArgs[1] -cne "${containerId}" -or $callArgs[-1] -ne '{{json .Mounts}}') { throw "Unexpected historical inspect" }
      '[{"Type":"bind","Source":"${source}","Destination":"/app/data","RW":true}]'; return
    }
    "image" { "${imageId}"; return }
    "run" {
      if ("${gate ?? ""}" -eq "" -or $callArgs -notcontains "none" -or $callArgs -notcontains "never" -or $callArgs -notcontains "${imageId}") { throw "Unexpected or unisolated Docker run" }
      $name = $callArgs[[array]::IndexOf($callArgs, "--name") + 1]
      $id = if ($name -like '*candidate-protocol-*') { '${"c".repeat(64)}' } elseif ($name -like '*rollback-protocol-*') { '${"d".repeat(64)}' } elseif ($name -like '*candidate-*') { '${"e".repeat(64)}' } else { '${"f".repeat(64)}' }
      $global:gateStates[$id] = $true
      $global:gateRestarts[$id] = 0
      $id; return
    }
    "exec" {
      $id = $callArgs[1]; $phase = $callArgs[-1]
      if (-not $global:gateStates[$id] -or $phase -notin @("prepare", "verify")) { throw "Invalid protocol phase or stopped container" }
      if ($phase -eq "verify" -and $global:gateRestarts[$id] -ne 1) { throw "Verify did not follow a real stop/start transition" }
      if ($id -eq '${"d".repeat(64)}' -and "${gate ?? ""}" -eq "unsupported") {
        $global:LASTEXITCODE = 1
        @{ protocol = "submissionClose"; phase = $phase; status = "rejected"; reason = "HTTP 404" } | ConvertTo-Json -Compress; return
      }
      if ($id -eq '${"d".repeat(64)}' -and "${gate ?? ""}" -eq "unknown") { "unknown probe output"; return }
      $lateStatus = if ($phase -eq "verify") { 409 } else { $null }
      if ($id -eq '${"d".repeat(64)}' -and $phase -eq "verify" -and "${gate ?? ""}" -eq "verifyFailure") { $lateStatus = 202 }
      $probeResult = @{ protocol = "submissionClose"; version = 1; phase = $phase; status = "passed"; taskCreated = $false; lateCreateStatus = $lateStatus; requestId = '11111111-1111-4111-8111-111111111111'; markerHash = ('a' * 64) }
      if ($id -eq '${"d".repeat(64)}' -and $phase -eq "verify") {
        if ("${gate ?? ""}" -eq "invalidTypes") { $probeResult.taskCreated = "false"; $probeResult.lateCreateStatus = "409" }
        if ("${gate ?? ""}" -eq "changedIdentity") { $probeResult.requestId = '22222222-2222-4222-8222-222222222222' }
      }
      $probeResult | ConvertTo-Json -Compress; return
    }
    "stop" {
      if (-not $global:gateStates.ContainsKey($callArgs[1])) { throw "Cannot stop an unrelated container" }
      $global:gateStates[$callArgs[1]] = $false; return
    }
    "start" {
      if (-not $global:gateStates.ContainsKey($callArgs[1]) -or $global:gateStates[$callArgs[1]]) { throw "Invalid restart target" }
      $global:gateStates[$callArgs[1]] = $true
      $global:gateRestarts[$callArgs[1]]++; return
    }
    "logs" { "isolated protocol transcript"; return }
    default { throw "Plan attempted a Docker mutation" }
  }
}
$failed = $false
try {
  & ${quote(upgradeScript)} -BackupPath ${quote(backup)} -CandidateImage isolatedCandidate -RollbackImage isolatedRollback -OutputRoot ${quote(output)} -BindSourceMap ${map} ${gate ? "-Execute" : ""}
} catch {
  $failed = $true
  [Console]::Error.WriteLine("scriptError:" + $_.Exception.Message)
} finally {
  if ($env:DOCKER_CONTEXT -cne "inheritedContext" -or $env:TOONFLOW_BACKUP_PASSWORD -cne "existingTestPassword") { throw "Plan changed existing environment" }
  if ($env:TOONFLOW_ADMIN_PASSWORD -cne "existingAdminPassword") { throw "Protocol probe changed admin password environment" }
  if (@($global:gateStates.Values | Where-Object { $_ }).Count) { throw "Probe container remained running" }
  [Console]::Error.WriteLine("environmentRestored")
}
if ($failed) { exit 1 }
`;
  try {
    const result = Bun.spawnSync([powershell, "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")], {
      env: { ...process.env, PATH: "", OS: "Windows_NT", DOCKER_HOST: undefined, DOCKER_CONTEXT: "inheritedContext", TOONFLOW_BACKUP_PASSWORD: "existingTestPassword", TOONFLOW_ADMIN_PASSWORD: "existingAdminPassword" },
      timeout: 15000,
    });
    const reports = ["candidate", "rollback"].map(stage => {
      const path = join(output, `${stage}Protocol.json`);
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    });
    return { exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(), outputExists: existsSync(output), reports };
  } finally {
    const actual = realpathSync(root);
    if (actual !== root || dirname(actual) !== realpathSync(tmpdir()) || !basename(actual).startsWith("toonflowUpgradePlan")) throw new Error("拒绝清理不属于本次测试的目录");
    rmSync(actual, { recursive: true, force: true });
  }
}

describe.skipIf(process.platform !== "win32")("Upgrade historical bind mapping plan", () => {
  for (const [mapping, message] of [["missing", "提供精确候选路径"], ["caseMismatch", "提供精确候选路径"], ["overlap", "可写数据挂载重叠"]] as const) {
    test(`rejects ${mapping} mapping without creating helpers or output`, () => {
      const result = runUpgrade(mapping);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain(message);
      expect(result.stderr).not.toMatch(/docker:(create|run|start|stop)\b/);
      expect(result.stderr).toContain("environmentRestored");
      expect(result.outputExists).toBe(false);
    });
  }
  test("exact nonoverlapping candidate remains an unverified read-only plan", () => {
    const result = runUpgrade("candidate");
    expect(result.exitCode).toBe(0);
    expect(result.stdout + result.stderr).toContain("当前只读计划不证明映射安全");
    expect(result.stdout).toContain("只读计划结束");
    expect(result.stderr).not.toMatch(/docker:(create|run|start|stop)\b/);
    expect(result.stderr).toContain("environmentRestored");
    expect(result.outputExists).toBe(false);
  });
});

describe.skipIf(process.platform !== "win32")("Upgrade submission protocol gate", () => {
  for (const gate of ["unsupported", "unknown", "verifyFailure", "invalidTypes", "changedIdentity"] as const) {
    test(`rejects ${gate} rollback without asking for backup password or restoring data`, () => {
      const result = runUpgrade("candidate", gate);
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("未恢复备份");
      expect(result.stderr).not.toContain("passwordPrompt");
      expect(result.stderr).not.toContain("restore:");
      expect(result.stderr).toContain("environmentRestored");
      expect(result.stdout).not.toContain("两个独立副本的恢复与启动观察结束");
      expect(result.reports[0]).toMatchObject({ status: "passed", restartVerified: true });
      expect(result.reports[1]).toBeNull();
    });
  }

  test("only both supported images unlock restore, with required restarts and explicit compatibility limits", () => {
    const result = runUpgrade("candidate", "supported");
    expect(result.exitCode).toBe(0);
    for (const report of result.reports) expect(report).toMatchObject({ status: "passed", restartVerified: true, lateCreateStatus: 409 });
    const verified = result.stderr.indexOf(`docker:exec ${"d".repeat(64)} verify`);
    const password = result.stderr.indexOf("passwordPrompt");
    const restored = result.stderr.indexOf("restore:");
    expect(verified).toBeGreaterThan(-1);
    expect(password).toBeGreaterThan(verified);
    expect(restored).toBeGreaterThan(password);
    expect(result.stderr.match(/restore:/g)?.length).toBe(2);
    expect(result.stderr).toContain("environmentRestored");
    expect(result.stdout + result.stderr).toContain("不证明完整业务回滚安全");
    expect(result.stdout).toContain("不代表登录、生成、费用、迁移兼容或完整业务回滚通过");
  });

  test("passing protocol gates cannot turn a later restore failure into a successful or safe rollback", () => {
    const result = runUpgrade("candidate", "restoreFailure");
    expect(result.exitCode).not.toBe(0);
    expect(result.reports.every(report => report?.status === "passed")).toBe(true);
    expect(result.stderr).toContain("candidate 恢复失败");
    expect(result.stderr).toContain("environmentRestored");
    expect(result.stderr.match(/restore:/g)?.length).toBe(1);
    expect(result.stderr).not.toMatch(/--name toonflow-drill-(candidate|rollback)-\d/);
    expect(result.stdout).not.toContain("两个独立副本的恢复与启动观察结束");
  });
});
