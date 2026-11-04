; build/installer.nsh — DeepSeek Harness NSIS 定制（electron-builder `nsis.include` 自动引入）
; 1) 全新安装默认 D:\<应用名>（D 盘存在时），目录页可改；升级/重装沿用历史路径
; 2) 简约欢迎页（配 build/installerSidebar.bmp 品牌侧栏）
; 3) 安装/卸载前自动结束正在运行的应用（不再弹「无法关闭，请手动关闭」）

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TITLE "欢迎使用 DeepSeek Harness"
  !define MUI_WELCOMEPAGE_TEXT "桌面壳 · 开箱即用$\r$\n$\r$\n默认安装到 D 盘，安装过程中可自行更改路径。$\r$\n点击“下一步”继续。"
  !insertmacro MUI_PAGE_WELCOME
!macroend

!macro customInit
  ; 历史安装路径（升级/重装）：initMultiUser 已填好 $INSTDIR，直接保留
  ReadRegStr $R0 HKLM "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $R0 "" 0 dsh_init_done
  ReadRegStr $R0 HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
  StrCmp $R0 "" dsh_check_d dsh_init_done
  dsh_check_d:
  ; 全新安装：D 盘存在即默认 D:\<应用名>；无 D 盘回退 Program Files 默认值
  IfFileExists "D:\nul" 0 dsh_init_done
    StrCpy $INSTDIR "D:\${APP_FILENAME}"
  dsh_init_done:
!macroend

; ---------------------------------------------------------------------------
; 3) 安装/卸载前自动结束正在运行的应用
;
; 背景：electron-builder 默认的 CHECK_APP_RUNNING 会先尝试「优雅关闭」（taskkill 不带 /F），
; 但本壳子把窗口 close 事件拦截成了「最小化到托盘」，优雅关闭对它无效；重试两轮后
; 安装器就弹「DeepSeek Harness 无法关闭，请手动关闭它，然后单机重试以继续」，
; 用户必须自己去系统托盘图标右键找退出项——而托盘图标常被折叠进 ^ 隐藏区，基本找不到。
;
; 这里整体接管该检查（模板 CHECK_APP_RUNNING 检测到 customCheckAppRunning 就会走这里）：
; 直接强制结束，然后轮询确认进程真的消失，最多 4 轮；只有进程以更高权限运行、
; 确实杀不掉时才退回系统自带的重试/取消提示。
;
; 注意**不带 /T**：只结束同名进程。壳子主进程与它的 GPU/渲染/网络/音频子进程同名
; （都叫 DeepSeek Harness.exe），会被一起结束；而 dsh 服务是 node.exe，保留下来，
; 装完重开壳子可直接复用该服务，会话无缝恢复，不必重新冷启动内核。
!macro customCheckAppRunning
  StrCpy $R1 0
  dsh_kill_app_loop:
    IntOp $R1 $R1 + 1
    DetailPrint "正在结束正在运行的 ${PRODUCT_NAME}（第 $R1 次尝试）..."
    nsExec::Exec 'taskkill /F /IM "${APP_EXECUTABLE_FILENAME}"'
    Pop $0
    Sleep 1200
    !insertmacro FIND_PROCESS "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 0
      ${If} $R1 >= 4
        MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDCANCEL IDRETRY dsh_kill_app_loop
        Quit
      ${EndIf}
      Goto dsh_kill_app_loop
    ${EndIf}
!macroend
