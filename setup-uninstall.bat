@echo off
chcp 65001 >nul
:: DeepSeek Harness 卸载器（卡片安装器配套）
setlocal
set "DIR=%~dp0"
set "DIR=%DIR:~0,-1%"
title DeepSeek Harness - 卸载

echo 正在关闭运行中的 DeepSeek Harness…
taskkill /F /IM "DeepSeek Harness.exe" >nul 2>&1
timeout /t 2 /nobreak >nul

echo 正在删除快捷方式…
del "%USERPROFILE%\Desktop\DeepSeek Harness.lnk" >nul 2>&1
rmdir /s /q "%APPDATA%\Microsoft\Windows\Start Menu\Programs\DeepSeek Harness" >nul 2>&1

echo 正在删除安装文件…
:: 自删除技巧：bat 删自身所在目录需经 cmd 跳板
set "SELF=%~f0"
start "" /min cmd /c "timeout /t 3 /nobreak >nul & rmdir /s /q %DIR% & reg delete \"HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\DeepSeek Harness\" /f >nul 2>&1 & echo 卸载完成"
exit
