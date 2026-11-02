; ============================================================================
; 自定义卸载页：选择要随应用一起删除的用户数据
;
; 结构（2026-10-26 用户确认）——两个平级项，默认都不勾：
;   [ ] 删除设置与凭证数据  (…\.craft-agent)         <- BS_AUTOCHECKBOX，两态
;   [ ] 删除工作区                                   <- BS_AUTO3STATE，三态
;         [ ] My Workspace    D:\…                   <- BS_AUTOCHECKBOX，每个工作区一行
;         [ ] craft-test      D:\craft-test
;
; 「删除工作区」的三态由系统原生画：全勾=勾、全不勾=空、部分选中=横杠。
;
; 为什么不用上一版的 SysTreeView32 + TVS_CHECKBOXES：
;   comctl 的勾选框状态图要自己造 4 张 16x16 位图，DrawThemeBackground /
;   DrawFrameControl 往兼容位图里画实测输出空白，整列勾选框消失（见交接文档 §2.2）。
;   原生 BUTTON 控件由主题引擎直接绘制：外观和系统勾选框完全一致（Win10/11 都正确），
;   三态横杠是系统行为，不需要自绘，也不需要 ImageList。
;
; 数据来源（应用保存配置时写出，两个文件同序、同数量）：
;   $PROFILE\.craft-agent\workspaces.list   → 每行一条显示文本（应用已排版）
;   $PROFILE\.craft-agent\workspaces.paths  → 每行一个绝对路径
;
; 删除语义（2026-10-26 用户确认）：
;   - 默认全部不勾（保命）
;   - 工作区一律「整个目录移入回收站」，可从回收站还原
;   - 设置与凭证是永久删除
;   - 安装目录与 Electron 缓存无论如何都删
;   - 静默卸载（/S）没有页面，因此一律保留用户数据
;
; 由 electron-builder 的 `nsis.include` 引入。模板 assistedInstaller.nsh 里有：
;   !ifmacrodef customUnWelcomePage
;     !insertmacro customUnWelcomePage      <-- 用它整体替换默认欢迎页
;   !else
;     !insertmacro MUI_UNPAGE_WELCOME
;   !endif
; 所以不需要改 node_modules 里的模板，升级 electron-builder 也不会失效。
; 注意：这条路径只在 electron-builder 的 assisted 安装器（oneClick: false）下成立；
; oneClick: true 时模板只插入 MUI_UNPAGE_INSTFILES 且强制静默卸载，本页不会出现。
;
; 本文件用 UTF-8 BOM 保存：makensis 以 BOM 判断脚本编码，没有 BOM 会按 ANSI(GBK)
; 解析，下面的中文 LangString 就会变乱码。
; ============================================================================

!ifndef CRAFT_UNINSTALL_PAGE_NSH
!define CRAFT_UNINSTALL_PAGE_NSH

!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "WinMessages.nsh"

; electron-builder 用 makensis -WX 编译（警告即错误）。只要本文件声明了
; `Function un.*` + `UninstPage`，某个编译 pass 里就会出现：
;   warning 6020: Uninstaller script code found but WriteUninstaller never used
; 这条警告只说明该 pass 不产出卸载器，不是缺陷（真正的卸载器由另一个 pass 生成）。
!pragma warning disable 6020

; ---- 品牌图标 ----
; MUI 默认用 NSIS 自带的 modern-uninstall.ico：标题栏图标和页眉右上角 32×32 都是它。
; MUI_UNICON 同时驱动 UninstallIcon（exe/标题栏）和 mui.Header.Image（页眉右上角）。
; 用 ${__FILEDIR__} 相对本文件定位，避免写死机器路径；electron-builder 如果自己
; 传了 -DMUI_*，!ifndef 会尊重它，不会打架。
!define /ifndef MUI_ICON   "${__FILEDIR__}\..\resources\icon.ico"
!define /ifndef MUI_UNICON "${__FILEDIR__}\..\resources\icon.ico"

; ---- 底部品牌文字 ----
; NSIS 默认在窗口底部打 "Nullsoft Install System v3.04"。BrandingText 是全局设置，
; 安装器和卸载器共用，所以改这一处两个窗口一起生效。版本号由 electron-builder 用
; -DVERSION 传入；harness 里没有定义就只打产品名。
!ifdef VERSION
  BrandingText "Craft Agents ${VERSION}"
!else
  BrandingText "Craft Agents"
!endif

; ---- 语言 id ----
; 这一版 NSIS(3.04) 的 makensis 不自带 LANG_* 常量（用 ${LANG_ENGLISH} 会报
; warning 7025 并把语言 id 当 1033），这里自己定义，和 electron-builder.yml 的
; installerLanguages（en_US / zh_CN）对齐。缺某个语言时该语言串只是用不到。
!define /ifndef CRAFT_LANG_EN 1033   ; English
!define /ifndef CRAFT_LANG_ZH 2052   ; SimpChinese

LangString CRAFT_UN_TITLE     ${CRAFT_LANG_EN} "Choose what to remove"
LangString CRAFT_UN_TITLE     ${CRAFT_LANG_ZH} "选择要删除的内容"
LangString CRAFT_UN_SUBTITLE  ${CRAFT_LANG_EN} "Craft Agents is being uninstalled. Nothing is deleted unless you select it here."
LangString CRAFT_UN_SUBTITLE  ${CRAFT_LANG_ZH} "正在卸载 Craft Agents。以下数据默认全部保留，勾选后才会删除。"
LangString CRAFT_UN_CONFIG    ${CRAFT_LANG_EN} "Delete settings and credentials"
LangString CRAFT_UN_CONFIG    ${CRAFT_LANG_ZH} "删除设置与凭证数据"
LangString CRAFT_UN_WS        ${CRAFT_LANG_EN} "Delete workspaces"
LangString CRAFT_UN_WS        ${CRAFT_LANG_ZH} "删除工作区"
LangString CRAFT_UN_NOTE      ${CRAFT_LANG_EN} "Selected workspaces are moved to the Recycle Bin and can be restored; settings and credentials are deleted permanently.$\r$\nThe application files are always removed."
LangString CRAFT_UN_NOTE      ${CRAFT_LANG_ZH} "勾选的工作区会移入回收站（可还原）；设置与凭证数据将被永久删除。$\r$\n应用程序文件无论如何都会被移除。"
LangString CRAFT_UN_MORE_PRE  ${CRAFT_LANG_EN} "… and "
LangString CRAFT_UN_MORE_PRE  ${CRAFT_LANG_ZH} "… 另有 "
LangString CRAFT_UN_MORE_POST ${CRAFT_LANG_EN} " more workspace(s) are not listed above and will be kept."
LangString CRAFT_UN_MORE_POST ${CRAFT_LANG_ZH} " 个工作区未在上方列出，将被保留。"

; ---- 布局 ----
; 坐标一律带 u（随 DPI 缩放的像素：150% 缩放下 1u ≈ 1.5px）。
; 实测页面内容区 = 300u × 140u（96dpi 基准）。预算：
;   设置行 0..12u、「删除工作区」16..28u、子项 29u 起每行 13u、说明最多 3 行 28u。
; 子项行数上限 5：29 + 5*13 + 5 + 28 = 127u，仍在 140u 内；
; 再多就不列出来，只统计数量并在说明里注明「将被保留」。
!define /ifndef CRAFT_UN_MAX_ROWS 5

; ---- 三态勾选框 ----
; nsDialogs 只提供 BS_AUTOCHECKBOX；「删除工作区」要 BS_AUTO3STATE（系统会画横杠）。
; 用法同 ${NSD_CreateCheckbox}：${NSD_Create3StateCheckbox} x y w h "text"
!define __NSD_3StateCheckbox_STYLE ${DEFAULT_STYLES}|${WS_TABSTOP}|${BS_TEXT}|${BS_VCENTER}|${BS_AUTO3STATE}|${BS_MULTILINE}
!define NSD_Create3StateCheckbox "nsDialogs::CreateControl BUTTON ${__NSD_3StateCheckbox_STYLE} 0 "

Var craftPage        ; nsDialogs 页面 dialog
Var craftCfgChk      ; 「删除设置与凭证数据」勾选框 hwnd
Var craftWsParent    ; 「删除工作区」三态勾选框 hwnd
Var craftRowH        ; 行清单文件句柄（每行一个子项 hwnd）
Var craftRowsFile    ; $PLUGINSDIR\craft-un-rows.txt（只存工作区子项）
Var craftSelFile     ; $PLUGINSDIR\craft-un-sel.txt（每行 1/0，与 workspaces.paths 同序）
Var craftDelConfig   ; 卸载时是否删 .craft-agent
Var craftDelWorkspaces ; 卸载时是否有工作区要移入回收站
Var craftCfgDir      ; $PROFILE\.craft-agent
Var craftWsList      ; workspaces.list（UTF-8 原始文件）
Var craftWsAnsi      ; workspaces.list 的 ANSI(当前代码页) 副本，专供 FileRead 读
Var craftWsRead      ; 实际读的那个文件（副本存在就用副本）
Var craftWsPaths     ; workspaces.paths
Var craftWsCount     ; 读到的工作区条数（含没列出的）
Var craftHidden      ; 因为行数上限没列出来的条数
Var craftY           ; 下一个控件的 y（数字，配合 $craftU 拼成 "29u"）
Var craftU           ; 常量 "u"
Var craftYArg        ; y + "u"
Var craftCfgLabel    ; 设置行的完整文案
Var craftNote        ; 底部说明文案

; ---------------------------------------------------------------- 行清单工具

; 去掉行尾 CR/LF。入参/出参：$9（内部用 $8 当临时变量）
Function un.craftTrimEol
  StrCpy $8 $9 1 -1
  ${If} $8 == "$\n"
    StrCpy $9 $9 -1
  ${EndIf}
  StrCpy $8 $9 1 -1
  ${If} $8 == "$\r"
    StrCpy $9 $9 -1
  ${EndIf}
FunctionEnd

; 把所有工作区子项设成同一状态。入参：$0 = 0/1（内部用 $1/$9）
Function un.craftSetRows
  FileOpen $1 "$craftRowsFile" r
  ${If} $1 == ""
    Return
  ${EndIf}
  ${Do}
    ClearErrors
    FileRead $1 $9
    ${If} ${Errors}
      ${ExitDo}
    ${EndIf}
    Call un.craftTrimEol
    ${If} $9 != ""
      ${NSD_SetState} $9 $0
    ${EndIf}
  ${Loop}
  FileClose $1
FunctionEnd

; 由工作区子项反推「删除工作区」的态：全勾=1 / 部分选中=2（系统横杠）/ 全不勾=0
Function un.craftSyncParent
  StrCpy $0 "0"   ; 已勾数
  StrCpy $1 "0"   ; 总数
  FileOpen $2 "$craftRowsFile" r
  ${If} $2 == ""
    Return
  ${EndIf}
  ${Do}
    ClearErrors
    FileRead $2 $9
    ${If} ${Errors}
      ${ExitDo}
    ${EndIf}
    Call un.craftTrimEol
    ${If} $9 != ""
      IntOp $1 $1 + 1
      ${NSD_GetState} $9 $3
      ${If} $3 == ${BST_CHECKED}
        IntOp $0 $0 + 1
      ${EndIf}
    ${EndIf}
  ${Loop}
  FileClose $2

  ${If} $1 == 0
    Return      ; 没有工作区：父项保持原样（页面里已被禁用）
  ${EndIf}
  ${If} $0 == $1
    StrCpy $3 ${BST_CHECKED}
  ${ElseIf} $0 == 0
    StrCpy $3 ${BST_UNCHECKED}
  ${Else}
    StrCpy $3 ${BST_INDETERMINATE}
  ${EndIf}
  ${NSD_SetState} $craftWsParent $3
FunctionEnd

; ---------------------------------------------------------------- 点击联动

; 工作区子项被点：只重算父项
Function un.craftOnRowClick
  Call un.craftSyncParent
FunctionEnd

; 「删除工作区」被点：一次带全部子项。
; BS_AUTO3STATE 点一下会先在 0/1/2 之间自动走一格，这里把结果统一成两态：
; 变成「勾」→ 全部勾；变成其它（未勾 / 横杠）→ 全部不勾。
; 横杠只用来表示「部分选中」，不应该由点击进入。
Function un.craftOnParentClick
  ${NSD_GetState} $craftWsParent $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $0 ${BST_CHECKED}
  ${Else}
    StrCpy $0 ${BST_UNCHECKED}
  ${EndIf}
  Call un.craftSetRows
  ${NSD_SetState} $craftWsParent $0
FunctionEnd

; ---------------------------------------------------------------- 页面

Function un.craftPageShow
  ; 页眉文案（MUI 的标题/副标题静态控件，ID 1037/1038）。
  ; 这里不用 !insertmacro MUI_HEADER_TEXT：electron-builder 是把本文件
  ; 前插在生成脚本最前面的（scriptGenerator.build() + originalScript），那时
  ; MUI2.nsh 还没 include，宏未定义会直接编译失败。而 MUI_HEADER_TEXT 本身
  ; 也只是对这两个控件发 WM_SETTEXT，直接调一样的效果、不依赖 include 顺序。
  GetDlgItem $0 $HWNDPARENT 1037
  ${If} $0 != 0
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(CRAFT_UN_TITLE)"
  ${EndIf}
  GetDlgItem $0 $HWNDPARENT 1038
  ${If} $0 != 0
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(CRAFT_UN_SUBTITLE)"
  ${EndIf}

  InitPluginsDir
  StrCpy $craftDelConfig "0"
  StrCpy $craftDelWorkspaces "0"
  StrCpy $craftU "u"

  ReadEnvStr $0 "USERPROFILE"
  StrCpy $craftCfgDir "$0\.craft-agent"
  StrCpy $craftWsList "$craftCfgDir\workspaces.list"
  StrCpy $craftWsPaths "$craftCfgDir\workspaces.paths"
  ; workspaces.list 是 UTF-8，而 NSIS 的 FileRead 恒按 CP_ACP 解释字节
  ; （UTF-16LE / UTF-8 BOM 都不认，已实测），直接读会把中文工作区名读成乱码。
  ; un.onInit 里已经转过一份当前代码页的副本，有副本就读副本。
  StrCpy $craftWsRead "$craftWsList"
  ${If} ${FileExists} "$craftWsAnsi"
    StrCpy $craftWsRead "$craftWsAnsi"
  ${EndIf}
  StrCpy $craftRowsFile "$PLUGINSDIR\craft-un-rows.txt"
  StrCpy $craftSelFile "$PLUGINSDIR\craft-un-sel.txt"
  ; 和 customUnInit 里算的是同一个路径（那边负责生成副本，这边只用）。
  ; 这里再赋一次值是必要的：安装器那一趟不展开 customUnInit，变量只被读不被赋值
  ; 会触发 warning 6001，而 electron-builder 用 -WX 编译（警告=错误）会直接构建失败。
  StrCpy $craftWsAnsi "$PLUGINSDIR\craft-un-ws-ansi.txt"

  nsDialogs::Create 1018
  Pop $craftPage
  ${If} $craftPage == error
    Abort
  ${EndIf}

  ; ---- 第 1 项：删除设置与凭证数据（普通两态）----
  StrCpy $craftCfgLabel "$(CRAFT_UN_CONFIG)  ($craftCfgDir)"
  ${NSD_CreateCheckbox} 0 0 100% 12u "$craftCfgLabel"
  Pop $craftCfgChk
  ${NSD_SetState} $craftCfgChk ${BST_UNCHECKED}

  ; ---- 第 2 项：删除工作区（父项三态 + 每个工作区一个子项）----
  ${NSD_Create3StateCheckbox} 0 16u 100% 12u "$(CRAFT_UN_WS)"
  Pop $craftWsParent
  ${NSD_SetState} $craftWsParent ${BST_UNCHECKED}
  ${NSD_OnClick} $craftWsParent un.craftOnParentClick

  ; 行清单：每行一个子项 hwnd（只存工作区，设置项不算在内）
  StrCpy $craftWsCount "0"
  StrCpy $craftHidden "0"
  StrCpy $craftY "29"
  FileOpen $craftRowH "$craftRowsFile" w
  FileOpen $2 "$craftWsRead" r
  ${If} $2 != ""
    ${Do}
      ClearErrors
      FileRead $2 $9
      ${If} ${Errors}
        ${ExitDo}
      ${EndIf}
      Call un.craftTrimEol
      ${If} $9 == ""
        ${Continue}
      ${EndIf}
      IntOp $craftWsCount $craftWsCount + 1
      ${If} $craftWsCount <= ${CRAFT_UN_MAX_ROWS}
        ; 文本直接用应用写好的显示串（工作区名 + 路径）
        StrCpy $craftYArg "$craftY$craftU"
        ${NSD_CreateCheckbox} 11u "$craftYArg" 88% 12u "$9"
        Pop $3
        ${NSD_OnClick} $3 un.craftOnRowClick
        FileWrite $craftRowH "$3$\r$\n"
        IntOp $craftY $craftY + 13
      ${Else}
        IntOp $craftHidden $craftHidden + 1
      ${EndIf}
    ${Loop}
    FileClose $2
  ${EndIf}
  FileClose $craftRowH

  ; 一个工作区都没有时，父项没有可联动的东西，直接禁用避免点出「勾着但没选任何项」
  ${If} $craftWsCount == "0"
    ${NSD_SetState} $craftWsParent ${BST_UNCHECKED}
    System::Call "user32::EnableWindow(p $craftWsParent, i 0)"
  ${EndIf}

  ; ---- 底部说明 ----
  StrCpy $craftNote "$(CRAFT_UN_NOTE)"
  ${If} $craftHidden > 0
    StrCpy $craftNote "$craftNote$\r$\n$(CRAFT_UN_MORE_PRE)$craftHidden$(CRAFT_UN_MORE_POST)"
  ${EndIf}
  IntOp $craftY $craftY + 5
  StrCpy $craftYArg "$craftY$craftU"
  ${NSD_CreateLabel} 0 "$craftYArg" 100% 28u "$craftNote"
  Pop $0

  nsDialogs::Show
FunctionEnd

Function un.craftPageLeave
  ; 记录选择：设置项进变量，工作区逐行写 1/0（与 workspaces.paths 同序）。
  StrCpy $craftDelConfig "0"
  StrCpy $craftDelWorkspaces "0"

  ${NSD_GetState} $craftCfgChk $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $craftDelConfig "1"
  ${EndIf}

  FileOpen $1 "$craftRowsFile" r
  ${If} $1 == ""
    Return
  ${EndIf}
  FileOpen $3 "$craftSelFile" w
  ${Do}
    ClearErrors
    FileRead $1 $9
    ${If} ${Errors}
      ${ExitDo}
    ${EndIf}
    Call un.craftTrimEol
    ${If} $9 == ""
      ${Continue}
    ${EndIf}
    ${NSD_GetState} $9 $4
    ${If} $4 == ${BST_CHECKED}
      FileWrite $3 "1$\r$\n"
      StrCpy $craftDelWorkspaces "1"
    ${Else}
      FileWrite $3 "0$\r$\n"
    ${EndIf}
  ${Loop}
  FileClose $1
  ${If} $3 != ""
    FileClose $3
  ${EndIf}
FunctionEnd

; ---------------------------------------------------------------- 真正执行删除

; 整个目录移入回收站。NSIS 没有回收站 API，借 Microsoft.VisualBasic.FileIO：
;   OnlyErrorDialogs  → 失败才弹窗
;   SendToRecycleBin  → 可还原
!macro CraftRecycle _PATH
  nsExec::ExecToLog '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "if (Test-Path -LiteralPath $\"${_PATH}$\") { Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($\"${_PATH}$\", $\"OnlyErrorDialogs$\", $\"SendToRecycleBin$\") }"'
  Pop $0
!macroend

; ---- 中文用词修正 ----
; NSIS 的简体中文语言包沿用的是港台译法「解除安装」（见 Contrib\Language files\
; SimpChinese.nlf 的 ^UninstallCaption / ^UninstallBtn），大陆用户看的是「卸载」。
; 语言串只能在语言包加载完之后覆盖，所以放在 customHeader 里：
; electron-builder 的 installer.nsi 是在 !insertmacro addLangs 之后调 customHeader 的。
; （重定义已存在的 LangString 是允许的，-WX 下也实测不报警。）
!macro CraftLangOverrides
  LangString ^UninstallCaption       ${CRAFT_LANG_ZH} "$(^Name) 卸载"
  LangString ^UninstallBtn           ${CRAFT_LANG_ZH} "卸载(&U)"
  LangString ^UninstallingSubCaption ${CRAFT_LANG_ZH} "正在卸载"
  LangString ^UninstallingText       ${CRAFT_LANG_ZH} "这个向导将从你的计算机卸载 $(^NameDA) 。 $_CLICK"
  LangString ^UninstallingSubText    ${CRAFT_LANG_ZH} "卸载目录:"
  LangString ^ClickUninstall         ${CRAFT_LANG_ZH} "单击 [卸载(U)] 开始卸载进程。"
!macroend

!macro customHeader
  !insertmacro CraftLangOverrides
!macroend

; 卸载器启动时把 UTF-8 的 workspaces.list 转成一份「当前代码页(CP_ACP)」副本。
; 原因：NSIS 3.04 的 FileRead 恒按 CP_ACP 解释字节，UTF-8 里的中文会读成乱码；
; 而 UTF-16LE / UTF-8 BOM 它也不认（两种都实测过，依旧乱）。转成 ACP 后
; FileRead 读到的字符串才是对的。放在 un.onInit（而不是页面里）是为了不
; 让打开页面时卡上半秒。转换失败就留空，页面会退回直接读原文件。
!macro customUnInit
  ${IfNot} ${Silent}
    InitPluginsDir
    ReadEnvStr $R0 "USERPROFILE"
    StrCpy $R1 "$R0\.craft-agent\workspaces.list"
    StrCpy $craftWsAnsi "$PLUGINSDIR\craft-un-ws-ansi.txt"
    ${If} ${FileExists} "$R1"
      ; 外层用反引号作 NSIS 字符串定界符，里面的 " 和 ' 都不用转义
      nsExec::ExecToStack `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "[IO.File]::WriteAllText('$craftWsAnsi', [IO.File]::ReadAllText('$R1', [Text.Encoding]::UTF8), [Text.Encoding]::Default)"`
      Pop $0
      Pop $1
      ${IfNot} ${FileExists} "$craftWsAnsi"
        StrCpy $craftWsAnsi ""
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

!macro customUnWelcomePage
  UninstPage custom un.craftPageShow un.craftPageLeave
!macroend
!macro customUnInstall
  ReadEnvStr $R0 "USERPROFILE"
  ReadEnvStr $R2 "APPDATA"
  StrCpy $R1 "$R0\.craft-agent"

  ; 工作区：按选择文件逐条移入回收站（与 workspaces.paths 同序）。
  ; 静默卸载没有跑过页面，$craftDelWorkspaces 为空 → 用户数据一律保留。
  ${If} $craftDelWorkspaces == "1"
    FileOpen $2 "$craftWsPaths" r
    FileOpen $4 "$craftSelFile" r
    ${If} $2 != ""
    ${AndIf} $4 != ""
      ${Do}
        ClearErrors
        FileRead $2 $8
        ${If} ${Errors}
          ${ExitDo}
        ${EndIf}
        StrCpy $8 $8 -2
        ClearErrors
        FileRead $4 $9
        ${If} ${Errors}
          StrCpy $9 "0"
        ${EndIf}
        StrCpy $9 $9 -2
        ${If} $9 == "1"
        ${AndIf} $8 != ""
          !insertmacro CraftRecycle "$8"
        ${EndIf}
      ${Loop}
    ${EndIf}
    ${If} $2 != ""
      FileClose $2
    ${EndIf}
    ${If} $4 != ""
      FileClose $4
    ${EndIf}
  ${EndIf}

  ; 设置、凭据与草稿
  ${If} $craftDelConfig == "1"
    RMDir /r "$R1"
  ${EndIf}

  ; Electron 缓存与 UI 状态：无论如何删除（可再生）
  RMDir /r "$R2\@craft-agent"
!macroend

!endif ; CRAFT_UNINSTALL_PAGE_NSH
