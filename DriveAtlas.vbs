' Starts DriveAtlas without a console window and opens the app window.
' If DriveAtlas is already running, it just opens another window.
' Add the argument /hub to start the hub only (used by the Startup shortcut).
Option Explicit
Dim shell, fso, root, args
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
root = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = root & "\app"
args = "--background --open"
If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "/hub" Then args = "--background"
End If
shell.Run "node --disable-warning=ExperimentalWarning hub\main.mjs " & args, 0, False
