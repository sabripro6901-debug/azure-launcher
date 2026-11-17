; Uninstall keeps your instances, worlds and settings (they live in %APPDATA%\azure-launcher) unless you say yes here.
!macro customUnInstall
  IfSilent skipAsk
  MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Also delete your Azure Launcher data (instances, worlds, settings, accounts)?$\r$\n$\r$\nChoose No to keep it for a later reinstall." IDYES wipe IDNO skipAsk
  wipe:
    RMDir /r "$APPDATA\azure-launcher"
  skipAsk:
!macroend
