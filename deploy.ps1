# EnVo deploy - run ON THE VM, either by RDP (recommended) or via the
# "Deploy to VM" workflow_dispatch. Deploys deliberately; nothing auto-deploys
# on push anymore.
#
# It operates on a DEDICATED clone at $AppDir - NOT the CI runner's workspace -
# so the live app is isolated from CI churn. backend/.env here is set ONCE by
# hand and is never overwritten (no secret regeneration), so a bad secret or a
# stray 'git clean' in the runner workspace can't take prod down again.
#
# One-time VM setup (do this once):
#   git clone https://github.com/cassieaan-svg/envo-inventory-tracker.git C:\envo\app
#   copy "<current working backend\.env>" C:\envo\app\backend\.env
#   $pm2 = "C:\Users\eLIMS\AppData\Roaming\npm\pm2.cmd"
#   & $pm2 delete backend
#   Set-Location C:\envo\app\backend; & $pm2 start src/server.js --name backend; & $pm2 save
# Thereafter just run this script to deploy.

$ErrorActionPreference = 'Stop'

$AppDir = 'C:\envo\app'
$IisDir = 'C:\sites\envo'
$ApiUrl = 'https://envo.ecews.org'                       # baked into the frontend at build time
$Pm2    = 'C:\Users\eLIMS\AppData\Roaming\npm\pm2.cmd'

Write-Host "== EnVo deploy from $AppDir ==" -ForegroundColor Cyan
Set-Location $AppDir

# 1. Match origin/main exactly. reset --hard updates tracked files only, so the
#    untracked backend/.env is preserved.
git fetch origin
git reset --hard origin/main
git --no-pager log --oneline -1

# 2. Guard: the live env file must exist (set once; this script never writes it).
if (-not (Test-Path .\backend\.env)) {
  throw "backend/.env is missing at $AppDir\backend. Create it once by copying your working .env there."
}

# 3. Backend deps.
npm --prefix backend install --no-audit --no-fund

# 4. Frontend build (Vite inlines VITE_ vars from the environment).
$env:VITE_API_URL = $ApiUrl
npm --prefix frontend install --no-audit --no-fund
npm --prefix frontend run build                          # vite outDir '../dist' -> $AppDir\dist
if (-not (Test-Path .\dist\index.html)) { throw "frontend build produced no dist\index.html" }

# 5. Publish the frontend to IIS.
xcopy ".\dist\*" "$IisDir\" /E /I /Y

# 6. Restart the backend (pm2 runs it from $AppDir\backend). dotenv re-reads
#    backend/.env on every restart, so no --update-env is needed.
& $Pm2 restart backend
& $Pm2 save

Write-Host "== Deploy complete ==" -ForegroundColor Green
