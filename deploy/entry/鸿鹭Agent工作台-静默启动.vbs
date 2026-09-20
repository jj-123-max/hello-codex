' =============================================================================
'  Honglu Agent Workbench - silent launcher (no console window)
'  Keep this file ASCII-only: WSH reads .vbs as ANSI, non-ASCII would garble.
' =============================================================================
Option Explicit

Dim fso, shell, root, nodeExe, launcher, cmd
Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' this file lives in <ROOT>\, so its folder IS the root
root = fso.GetParentFolderName(WScript.ScriptFullName)

nodeExe  = root & "\runtime\node\node.exe"
launcher = root & "\launcher\launcher.js"

If Not fso.FileExists(launcher) Then
  MsgBox "Launcher not found:" & vbCrLf & launcher, 16, "Honglu Agent Workbench"
  WScript.Quit 1
End If

If Not fso.FileExists(nodeExe) Then
  ' fall back to a system Node on PATH
  nodeExe = "node"
End If

shell.CurrentDirectory = root
cmd = """" & nodeExe & """ """ & launcher & """"

' 0 = hidden window, False = do not wait
shell.Run cmd, 0, False
