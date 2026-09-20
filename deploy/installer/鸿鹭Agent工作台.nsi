; =============================================================================
;  鸿鹭Agent工作台 · Windows 安装器（分层式）
; =============================================================================
;  与传统安装器的区别：它只负责把「壳 + 运行时 + 首个版本」铺好，
;  之后所有升级都由 Launcher 在线完成，用户再也不需要新的 setup.exe。
;
;  安装后目录结构：
;    %LOCALAPPDATA%\HongluAgent\
;    ├─ launcher\          壳（本安装器写入，几乎不变）
;    ├─ runtime\           Node + dsh 引擎（跟大版本走）
;    ├─ versions\<版本>\   业务代码（升级只动这里，可多版本共存）
;    ├─ current\           → junction 指向当前版本
;    └─ data\              用户数据（升级永不触碰）
;
;  前置：先跑 node scripts\build-dist.js --node-dir <Node解压目录> 得到绿色包。
;
;  打安装器：
;    makensis /DAPP_SRC="dist\智能工作台-dsh-win" ^
;             /DVERSION="1.0.0" ^
;             /DUPDATE_URL="http://update.honglu.local/releases/latest.json" ^
;             installer\鸿鹭Agent工作台.nsi
;
;  没有域名？直接用 IP + 端口（内网直连，无需 DNS）：
;             /DUPDATE_URL="http://10.0.1.100:8090/latest.json"
;  注意：/DUPDATE_URL 会被写进安装目录的 data\launcher.config.json，
;        它是「用户级覆盖」，升级不会动它 —— 所以将来换 IP 时改这个文件即可，
;        不必让用户重装（可用域策略/登录脚本批量下发）。
;
;  可覆盖宏：
;    APP_SRC     绿色包目录（默认 ..\dist\智能工作台-dsh-win）
;    LAUNCHER_SRC 壳源码目录（默认 ..\deploy\launcher）
;    ENTRY_SRC   入口脚本目录（默认 ..\deploy\entry）
;    VERSION     版本号（默认 1.0.0）
;    UPDATE_URL  内网更新源清单地址（默认空 = 不检查更新）
;    ICON        图标 .ico（可选）
;    PER_USER    1=免管理员装到用户目录(默认) 0=Program Files 需管理员
; =============================================================================

Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 64

; ---- 产品信息 ----
!define APP_NAME    "鸿鹭Agent工作台"
!define APP_NAME_EN "HongluAgent"
!define PUBLISHER   "鸿鹭"
!define APP_SUBTITLE "企业智能研发工作台"

!ifndef VERSION
  !define VERSION "1.0.0"
!endif
!ifndef APP_SRC
  !define APP_SRC "..\dist\智能工作台-dsh-win"
!endif
!ifndef LAUNCHER_SRC
  !define LAUNCHER_SRC "..\deploy\launcher"
!endif
!ifndef ENTRY_SRC
  !define ENTRY_SRC "..\deploy\entry"
!endif
!ifndef UPDATE_URL
  !define UPDATE_URL ""
!endif
!ifndef PER_USER
  !define PER_USER 1
!endif

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_NAME_EN}"

Name "${APP_NAME}"
Caption "${APP_NAME} ${VERSION} 安装"
OutFile "..\dist\${APP_NAME}-Setup-${VERSION}.exe"
BrandingText "${PUBLISHER} · ${APP_SUBTITLE}"

!if ${PER_USER} == 1
  InstallDir "$LOCALAPPDATA\${APP_NAME_EN}"
  RequestExecutionLevel user
!else
  InstallDir "$PROGRAMFILES\${APP_NAME_EN}"
  RequestExecutionLevel admin
!endif

InstallDirRegKey HKCU "${UNINST_KEY}" "InstallDir"
ShowInstDetails show
ShowUninstDetails show

!ifndef ICON
  !if /FileExists "..\dist\icon.ico"
    !define ICON "..\dist\icon.ico"
  !endif
!endif
!ifdef ICON
  Icon "${ICON}"
  UninstallIcon "${ICON}"
!endif

; ---- 页面 ----
!include "MUI2.nsh"
!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "SimpChinese"

; =============================================================================
Function .onInit
  ; 已安装过？沿用上次的目录，实现"覆盖升级"
  ReadRegStr $0 HKCU "${UNINST_KEY}" "InstallDir"
  StrCmp $0 "" done
  StrCpy $INSTDIR $0
done:
FunctionEnd

; =============================================================================
Section "安装" SecMain
  ; ---- 0) 若工作台正在运行，先提示关闭（否则文件被占用会装失败）
  FindWindow $0 "" "${APP_NAME}"
  ; 用 pidfile 判断更可靠
  IfFileExists "$INSTDIR\data\server.pid" 0 noRunning
    MessageBox MB_OKCANCEL|MB_ICONEXCLAMATION \
      "检测到 ${APP_NAME} 正在运行。$\r$\n$\r$\n请先关闭工作台窗口（或双击「停止工作台.bat」），再点「确定」继续安装。" \
      IDOK noRunning
    Abort "用户取消了安装"
noRunning:

  ; ---- 1) 壳（入口脚本 + Launcher）
  SetOutPath "$INSTDIR"
  File /r "${ENTRY_SRC}\*.*"

  SetOutPath "$INSTDIR\launcher"
  File /r "${LAUNCHER_SRC}\*.*"
  ; lib/zip.js 是 launcher.js 的依赖，必须一起带上
  SetOutPath "$INSTDIR\lib"
  File /r "${LAUNCHER_SRC}\..\lib\*.*"

  ; ---- 2) 运行时（Node + dsh 引擎）
  SetOutPath "$INSTDIR\runtime\node"
  File /r "${APP_SRC}\.runtime\node\*.*"

  SetOutPath "$INSTDIR\runtime\dsh"
  File /r "${APP_SRC}\dsh-runtime\*.*"

  ; ---- 3) 首个版本（业务代码）
  SetOutPath "$INSTDIR\versions\${VERSION}"
  File /r "${APP_SRC}\src\*.*"
  File /r "${APP_SRC}\biz-web\*.*"
  File /r "${APP_SRC}\web\*.*"
  File /r "${APP_SRC}\custom\*.*"
  File /r "${APP_SRC}\scripts\*.*"
  File /r "${APP_SRC}\node_modules\*.*"
  File "${APP_SRC}\package.json"
  File "${APP_SRC}\package-lock.json"
  File /nonfatal "${APP_SRC}\config.default.json"
  ; 刻意不带 config.json：它是开发机上的"本机覆盖"，常含绝对路径
  ; （如 C:\Users\<某人>\.dsh），随包下发会污染所有用户机器。
  ; 用户侧配置一律走 data\user-config.json + data\.env + 环境变量。
  ; 此规则与 deploy/release/build-release.js 的排除列表保持一致。
  File /nonfatal "${APP_SRC}\README.md"

  ; ---- 4) 用户数据目录（dsh-home 骨架，profiles 让 dsh 首启自建）
  SetOutPath "$INSTDIR\data\dsh-home"
  File /r "${APP_SRC}\dsh-home\*.*"

  CreateDirectory "$INSTDIR\data\biz"
  CreateDirectory "$INSTDIR\data\logs"
  CreateDirectory "$INSTDIR\data\workspace"
  CreateDirectory "$INSTDIR\data\tmp"

  ; ---- 5) 写入版本状态（Launcher 的权威指针）
  FileOpen $0 "$INSTDIR\data\state.json" w
  FileWrite $0 '{$\r$\n'
  FileWrite $0 '  "activeVersion": "${VERSION}",$\r$\n'
  FileWrite $0 '  "previousVersion": "",$\r$\n'
  FileWrite $0 '  "failedVersions": [],$\r$\n'
  FileWrite $0 '  "runtimeVersion": "",$\r$\n'
  FileWrite $0 '  "pendingRuntime": null,$\r$\n'
  FileWrite $0 '  "lastCheck": "",$\r$\n'
  FileWrite $0 '  "installedAt": "${VERSION}",$\r$\n'
  FileWrite $0 '  "updatedAt": ""$\r$\n'
  FileWrite $0 '}$\r$\n'
  FileClose $0

  ; ---- 6) 更新源地址（写用户级覆盖，不动壳里的默认值）
!if "${UPDATE_URL}" != ""
  FileOpen $0 "$INSTDIR\data\launcher.config.json" w
  FileWrite $0 '{$\r$\n'
  FileWrite $0 '  "updateUrl": "${UPDATE_URL}",$\r$\n'
  FileWrite $0 '  "channel": "stable"$\r$\n'
  FileWrite $0 '}$\r$\n'
  FileClose $0
!endif

  ; ---- 7) 注册表 / 快捷方式
  WriteRegStr HKCU "${UNINST_KEY}" "InstallDir" "$INSTDIR"

  !ifdef ICON
    CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\鸿鹭Agent工作台.bat" "" "$INSTDIR\icon.ico" 0
  !else
    CreateShortCut "$DESKTOP\${APP_NAME}.lnk" "$INSTDIR\鸿鹭Agent工作台.bat"
  !endif

  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME}.lnk"      "$INSTDIR\鸿鹭Agent工作台.bat"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\停止工作台.lnk"        "$INSTDIR\停止工作台.bat"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\诊断工具.lnk"          "$INSTDIR\诊断工具.bat"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\打开数据目录.lnk"      "$INSTDIR\data"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载.lnk"              "$INSTDIR\uninstall.exe"

  WriteUninstaller "$INSTDIR\uninstall.exe"

  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName"     "${APP_NAME}"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion"  "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher"       "${PUBLISHER}"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  !ifdef ICON
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\icon.ico"
  !else
    WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\鸿鹭Agent工作台.bat"
  !endif
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "http://127.0.0.1:4000"
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
SectionEnd

; =============================================================================
Section "Uninstall"
  ; 数据是否保留——这是最容易被误删的东西，必须问清楚
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "是否同时删除用户数据？$\r$\n$\r$\n包含：会话记录、知识库/规则库、模型密钥、日志。$\r$\n$\r$\n选「否」将保留 $INSTDIR\data 目录。" \
    IDYES deleteAll

  ; 保留数据：只删程序
  RMDir /r "$INSTDIR\launcher"
  RMDir /r "$INSTDIR\lib"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\versions"
  Delete "$INSTDIR\current"
  RMDir "$INSTDIR\current"
  Delete "$INSTDIR\鸿鹭Agent工作台.bat"
  Delete "$INSTDIR\鸿鹭Agent工作台-静默启动.vbs"
  Delete "$INSTDIR\停止工作台.bat"
  Delete "$INSTDIR\诊断工具.bat"
  Delete "$INSTDIR\uninstall.exe"
  Goto shortcuts

deleteAll:
  RMDir /r "$INSTDIR"

shortcuts:
  Delete "$DESKTOP\${APP_NAME}.lnk"
  RMDir /r "$SMPROGRAMS\${APP_NAME}"
  DeleteRegKey HKCU "${UNINST_KEY}"
SectionEnd
