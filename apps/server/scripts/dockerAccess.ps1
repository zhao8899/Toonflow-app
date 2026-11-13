param([string]$Image = "toonflow-local:candidate-20261030110331")
$ErrorActionPreference = "Stop"
$name = "toonflow-access-$(Get-Date -Format yyyyMMddHHmmss)"
$started = $false
$probe = @'
import { mkdir } from "@toonflow/file";
const base = "http://127.0.0.1:3000";
const directory = "/app/data/workspaces/accessVerification";
await mkdir(directory, {recursive:true});
let ready = false;
for(let i=0;i<30;i++) {
  try { if((await fetch(base,{signal:AbortSignal.timeout(2000)})).ok) {ready=true;break;} } catch {}
  await Bun.sleep(1000);
}
if(!ready) throw new Error("Readiness timeout");
let checks=0;
async function call(label,path,status,cookie="",method="GET",body,extra={}) {
  const response=await fetch(base+path,{method,signal:AbortSignal.timeout(15000),headers:{origin:base,"x-toonflow-workspace":"1",...(cookie?{cookie}:{}),...(body?{"content-type":"application/json"}:{}),...extra},body:body?JSON.stringify(body):undefined});
  if(response.status!==status) throw new Error(`${label}: expected ${status}, received ${response.status}`);
  checks++;console.log(`PASS ${label} (${status})`);return response;
}
const password=process.env.TOONFLOW_ADMIN_PASSWORD;
async function login(username) {
  const response=await call(`login ${username}`,"/api/auth/login",200,"","POST",{username,password});
  const cookie=response.headers.get("set-cookie");
  if(!cookie?.includes("HttpOnly") || !cookie.includes("SameSite=Strict")) throw new Error("Cookie flags missing");
  return cookie.split(";")[0];
}
await call("anonymous blocked","/api/settings/get",401);
const admin=await login("verifyAdmin");
const {data:user}=await (await call("create member","/api/users/create",201,admin,"POST",{username:"verifyMember",password,role:"user"})).json();
let member=await login("verifyMember");
const {data:project}=await (await call("register project","/api/projects/register",200,admin,"POST",{directory,name:"Isolated candidate verification"})).json();
await call("nonmember blocked",`/api/projects/get?id=${project.id}`,404,member);
await call("grant membership","/api/projects/members",200,admin,"PUT",{id:project.id,members:[user.id]});
await call("member project visible",`/api/projects/get?id=${project.id}`,200,member);
await call("member settings blocked","/api/settings/get",403,member);
await call("member cost blocked","/api/ai/media/tasks/costHistory",403,member);
await call("grant model","/api/projects/mediaModels",200,admin,"PUT",{id:project.id,models:[{providerId:"daochengCloud",modelId:"doubao-seedance-2-0-260128"}]});
await call("set daily limit","/api/projects/generation",200,admin,"PUT",{id:project.id,enabled:true,dailyLimit:1,billingOwner:"instance"});
const scope={"x-toonflow-project-id":project.id,"x-toonflow-user-id":user.id};
const requestId=crypto.randomUUID();
const body={directory,requestId,mediaType:"video",providerId:"daochengCloud",modelId:"doubao-seedance-2-0-260128",prompt:"Isolated verification",mode:"text",duration:4,resolution:"1080p",ratio:"16:9",generateAudio:false};
await call("wrong account blocked","/api/ai/media/tasks/create",403,member,"POST",body,{...scope,"x-toonflow-user-id":"wrongAccount"});
await call("accept first request","/api/ai/media/tasks/create",202,member,"POST",body,scope);
const taskUrl="/api/ai/media/tasks/get?"+new URLSearchParams({directory,id:requestId});
let task;
for(let i=0;i<30;i++) {
 const r=await fetch(base+taskUrl,{headers:{cookie:member,origin:base,"x-toonflow-workspace":"1",...scope},signal:AbortSignal.timeout(5000)});
 if(!r.ok) throw new Error(`Task polling HTTP ${r.status}`);
 task=(await r.json()).data;
 if(task.status==="failed")break;
 await Bun.sleep(100);
}
if(task?.status!=="failed" || task.billingState!=="notSubmitted") throw new Error("Expected failure before supplier submission (no key configured)");
console.log("PASS no supplier submission");
await call("same ID returns original","/api/ai/media/tasks/create",202,member,"POST",body,scope);
await call("exhausted quota blocked","/api/ai/media/tasks/create",429,member,"POST",{...body,requestId:crypto.randomUUID()},scope);
const {data:quota}=await (await call("quota visible","/api/ai/media/tasks/quota?"+new URLSearchParams({directory}),200,member,"GET",undefined,scope)).json();
if(quota.used!==1 || quota.remaining!==0)throw new Error("Quota count mismatch");
await call("revoke sessions","/api/auth/revokeSessions",200,member,"POST",{});
await call("old session blocked","/api/auth/session",401,member);
member=await login("verifyMember");
await call("original task query after login",taskUrl,200,member,"GET",undefined,scope);
await call("login does not reset quota","/api/ai/media/tasks/create",429,member,"POST",{...body,requestId:crypto.randomUUID()},scope);
await call("revoke membership","/api/projects/members",200,admin,"PUT",{id:project.id,members:[]});
await call("revoked member blocked",taskUrl,404,member,"GET",undefined,scope);
await call("disable member","/api/users/setStatus",200,admin,"PUT",{userId:user.id,status:"disabled"});
await call("disabled session blocked","/api/auth/session",401,member);
console.log(`COMPLETE: ${checks} candidate HTTP checks. Browser interactions not verified.`);
'@
try {
    docker image inspect $Image --format '{{.Id}}'
    if ($LASTEXITCODE -ne 0) { throw "Candidate image not found." }
    $env:TOONFLOW_ADMIN_PASSWORD = [guid]::NewGuid().ToString("N") + [guid]::NewGuid().ToString("N")
    docker run -d --name $name --network none `
      --env TOONFLOW_AUTH_REQUIRED=true --env TOONFLOW_ADMIN_USERNAME=verifyAdmin `
      --env TOONFLOW_ADMIN_PASSWORD $Image
    if ($LASTEXITCODE -ne 0) { throw "Could not start isolated container." }
    $started = $true
    $probe | docker exec -i $name bun -
    if ($LASTEXITCODE -ne 0) { throw "Candidate access verification failed; preserve output." }
} finally {
    Remove-Item Env:TOONFLOW_ADMIN_PASSWORD -ErrorAction SilentlyContinue
    if ($started) {
        docker stop $name
        if ($LASTEXITCODE -ne 0) { Write-Warning "Stop isolated container manually: $name" }
        Write-Output "Isolated container retained: $name. Contains temporary credentials; do not publish its inspect output."
    }
}
