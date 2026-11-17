import Foundation
import AppKit

print("🚀 Side Screen starting...")

// No args needed

// Entry point
let app = NSApplication.shared

// Setup main menu for keyboard shortcuts (Command+Q, etc.)
let mainMenu = NSMenu()

// App menu
let appMenu = NSMenu()
let appMenuItem = NSMenuItem()
appMenuItem.submenu = appMenu
let harmonyApp = HarmonyBridgeController.isApp
appMenu.addItem(NSMenuItem(title: harmonyApp ? "关于鸿蒙副屏" : "About Side Screen", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: ""))
let checkForUpdatesItem = NSMenuItem(title: "Check for Updates…", action: #selector(AppUpdater.checkForUpdates(_:)), keyEquivalent: "")
checkForUpdatesItem.target = AppUpdater.shared
if !harmonyApp { appMenu.addItem(checkForUpdatesItem) }
appMenu.addItem(NSMenuItem.separator())
appMenu.addItem(NSMenuItem(title: harmonyApp ? "退出鸿蒙副屏" : "Quit Side Screen", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q"))
mainMenu.addItem(appMenuItem)

// Edit menu (for standard text editing shortcuts)
let editMenu = NSMenu(title: "Edit")
let editMenuItem = NSMenuItem()
editMenuItem.submenu = editMenu
editMenu.addItem(NSMenuItem(title: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x"))
editMenu.addItem(NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c"))
editMenu.addItem(NSMenuItem(title: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v"))
editMenu.addItem(NSMenuItem(title: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a"))
mainMenu.addItem(editMenuItem)

app.mainMenu = mainMenu

let delegate = AppDelegate()

app.setActivationPolicy(.regular)

app.delegate = delegate
app.run()
