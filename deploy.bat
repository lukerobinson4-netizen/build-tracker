@echo off
cd C:\Claude\github\build-tracker
set /p BRANCH="Branch (main/staging): "
set /p MSG="Commit message: "
git add .
git commit -m "%MSG%"
git push origin %BRANCH%
echo.
echo Deploying to %BRANCH%...
echo Live at: https://%BRANCH%--dairy-creek-rd-build-tracker.netlify.app
pause