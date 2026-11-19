; Uninstall keeps your instances, worlds and settings (they live in %APPDATA%\azure-launcher) unless you say yes here.
; Never asked (and nothing deleted) when the uninstaller only runs as part of a launcher update, or silently.
; A game folder chosen in Settings lives somewhere else and is never deleted here.
!macro customUnInstall
  ${if} ${isUpdated}
    Goto skipAsk
  ${endif}
  IfSilent skipAsk
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your Azure Launcher data (instances, worlds, settings, accounts)?$\r$\n$\r$\nChoose No to keep it for a later reinstall.$\r$\nA game folder you chose yourself in Settings is not touched." IDYES wipe IDNO skipAsk
  wipe:
    RMDir /r "$APPDATA\azure-launcher"
  skipAsk:
!macroend
