@echo off
cd C:\Claude\github\build-tracker
echo.
echo  1. Push to staging
echo  2. Push to main
echo  3. Merge staging into main
echo.
set /p CHOICE="Choose (1/2/3): "

if "%CHOICE%"=="1" (
    set /p MSG="Commit message: "
    git add .
    git commit -m "%MSG%"
    git push origin staging
    echo.
    echo Deployed to staging:
    echo https://staging--dairy-creek-rd-build-tracker.netlify.app
)

if "%CHOICE%"=="2" (
    set /p MSG="Commit message: "
    git add .
    git commit -m "%MSG%"
    git push origin main
    echo.
    echo Deployed to main:
    echo https://dairy-creek-rd-build-tracker.netlify.app
)

if "%CHOICE%"=="3" (
    git checkout main
    git merge staging
    git push origin main
    git checkout staging
    echo.
    echo Merged staging into main and switched back to staging
    echo https://dairy-creek-rd-build-tracker.netlify.app
)

echo.
pause