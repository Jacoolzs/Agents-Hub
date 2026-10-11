@echo off
"%~dp0runtime\node.exe" "%~dp0scripts\launch.mjs"
if errorlevel 1 pause
