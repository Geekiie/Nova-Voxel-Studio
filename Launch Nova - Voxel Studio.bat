@echo off
setlocal EnableExtensions

REM Simple launcher for Nova - Voxel Studio (dev-style desktop run).
REM If you want a single .exe for sharing, run: npm run dist

cd /d "%~dp0"

REM Keep caches local to this folder (helps on locked-down machines).
set "npm_config_cache=%cd%\.npm-cache"
set "ELECTRON_CACHE=%cd%\.electron-cache"
set "ELECTRON_BUILDER_CACHE=%cd%\.electron-builder-cache"

REM Some setups have this set globally, which breaks Electron apps.
set "ELECTRON_RUN_AS_NODE="

REM Some PCs have npm configured for production installs, which skips Electron
REM because Electron is a devDependency in source releases.
set "NODE_ENV="
set "npm_config_production="
set "npm_config_omit="
set "npm_config_include=dev"

REM Always use the Windows cmd shim for npm (avoids weird npm.ps1 behavior).
set "NPM_CMD=npm.cmd"
where /q %NPM_CMD%
if errorlevel 1 (
  echo.
  echo npm not found. Install Node.js first, then try again.
  pause
  exit /b 1
)

REM sanity check: if npm itself is broken, don't loop forever
call %NPM_CMD% --version >nul 2>nul
if errorlevel 1 (
  echo.
  echo npm is installed but not working on this PC.
  echo Reinstall Node.js ^(LTS^) from https://nodejs.org/ and try again.
  pause
  exit /b 1
)

:start
if not exist "node_modules" (
  call :install_deps
  if errorlevel 1 goto :err
  REM deps are in; jump back through the normal flow (same window)
  goto :start
)

REM If dist exists but branding changed since the last build, rebuild.
set "NEED_REBUILD="
for /f %%I in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "$dist='dist\\index.html'; if(!(Test-Path $dist)){ '1'; exit }; $src=(Get-ChildItem -Recurse 'public\\branding' -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1).LastWriteTimeUtc; $dst=(Get-Item $dist).LastWriteTimeUtc; if($src -gt $dst){ '1' } else { '0' }"') do set "NEED_REBUILD=%%I"
if "%NEED_REBUILD%"=="1" (
  echo Rebuilding...
  call %NPM_CMD% run build
  if errorlevel 1 goto :err
  goto :start
)

if not exist "dist\\index.html" (
  echo Building app...
  call %NPM_CMD% run build
  if errorlevel 1 goto :err
  REM build is in; jump back through the normal flow (same window)
  goto :start
)

echo Launching...
REM Launch Electron, then exit so this cmd window closes.
set "ELECTRON_EXE=%cd%\\node_modules\\electron\\dist\\electron.exe"
if not exist "%ELECTRON_EXE%" (
  echo.
  echo Electron is missing. Repairing dependencies...
  call :repair_electron
  if errorlevel 1 goto :electron_missing
  goto :start
)

if "%NOVA_LAUNCHER_CHECK_ONLY%"=="1" (
  echo Launcher check passed.
  exit /b 0
)

start "" /d "%cd%" "%ELECTRON_EXE%" . >nul 2>nul
exit /b 0

:install_deps
echo Installing dependencies...
call %NPM_CMD% config set cache ".npm-cache" --location=project >nul 2>nul
call %NPM_CMD% install --include=dev
exit /b %errorlevel%

:repair_electron
call %NPM_CMD% config set cache ".npm-cache" --location=project >nul 2>nul
call %NPM_CMD% install --include=dev
if errorlevel 1 exit /b 1
call %NPM_CMD% rebuild electron --include=dev
if errorlevel 1 exit /b 1
if not exist "%ELECTRON_EXE%" exit /b 1
exit /b 0

:electron_missing
echo.
echo Electron is still missing after repair.
echo Expected: %ELECTRON_EXE%
echo.
echo This usually means antivirus quarantined Electron, the folder is locked,
echo or the download/extraction is incomplete. Move the folder somewhere normal
echo like Desktop, allow it in antivirus if needed, then run this launcher again.
pause
exit /b 1

:err
echo.
echo Launch failed. Scroll up for the error.
pause
exit /b 1
