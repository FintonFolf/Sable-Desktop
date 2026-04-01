const { app, BrowserWindow, session, Notification, ipcMain, Tray, Menu, shell, desktopCapturer, systemPreferences, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { KNOWN_INSTANCES } = require('./servers');

if (process.platform === 'linux') {
    app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
    app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
}

let mainWindow;
let tray = null;
let pickerWindow = null;
let switcherWindow = null;
let welcomeWindow = null;
let pendingPickerCallback = null;
let cachedSources = [];
app.isQuitting = false;


function getStatePath() {
    return path.join(app.getPath('userData'), 'instances.json');
}

function loadState() {
    try {
        const data = JSON.parse(fs.readFileSync(getStatePath(), 'utf8'));
        if (Array.isArray(data)) {
            return { instances: data, activeUrl: data[0]?.url || KNOWN_INSTANCES[0].url };
        }
        return data;
    } catch {
        return null;
    }
}

function saveState() {
    fs.writeFileSync(getStatePath(), JSON.stringify({ instances, activeUrl }, null, 2));
}

const savedState = loadState();
const isFirstRun = savedState === null;
let instances = savedState?.instances ?? KNOWN_INSTANCES;
let activeUrl = savedState?.activeUrl ?? KNOWN_INSTANCES[0].url;

const getIconPath = () => app.isPackaged
    ? path.join(process.resourcesPath, 'favicon.png')
    : path.join(__dirname, 'assets/favicon.png');

const getTrayIconPath = () => app.isPackaged
    ? path.join(process.resourcesPath, 'tray-icon.png')
    : path.join(__dirname, 'assets/tray-icon.png');

const r = (file) => path.join(__dirname, file);

function isTrustedHost(url) {
    try {
        return new URL(url).hostname === new URL(activeUrl).hostname;
    } catch {
        return false;
    }
}

function openSwitcher() {
    if (switcherWindow) {
        switcherWindow.focus();
        return;
    }
    switcherWindow = new BrowserWindow({
        width: 420,
        height: 480,
        parent: mainWindow,
        modal: false,
        resizable: false,
        title: 'Switch Instance',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: r('preload/instances.js'),
        },
    });
    switcherWindow.removeMenu();
    switcherWindow.loadFile(r('renderer/instances.html'), { query: { mode: 'switcher' } });
    switcherWindow.on('closed', () => { switcherWindow = null; });
}

function openWelcomeWindow() {
    welcomeWindow = new BrowserWindow({
        width: 480,
        height: 500,
        resizable: false,
        title: 'Welcome to Sable',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: r('preload/instances.js'),
        },
    });
    welcomeWindow.removeMenu();
    welcomeWindow.loadFile(r('renderer/instances.html'), { query: { mode: 'welcome' } });
    welcomeWindow.on('closed', () => {
        welcomeWindow = null;
        if (!mainWindow) app.quit();
    });
}

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
        }
    });

    function createWindow() {
        mainWindow = new BrowserWindow({
            width: 1200,
            height: 800,
            title: 'Sable Client',
            icon: getIconPath(),
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: true,
                spellcheck: true,
                preload: r('preload/app.js'),
            },
        });

        mainWindow.removeMenu();

        mainWindow.webContents.on('did-finish-load', () => {
            mainWindow.webContents.executeJavaScript('localStorage.setItem("notificationsEnabled", "true");');
        });

        mainWindow.webContents.on('enter-html-full-screen', () => {
            mainWindow.setFullScreen(true);
        });

        mainWindow.webContents.on('leave-html-full-screen', () => {
            mainWindow.setFullScreen(false);
        });

        mainWindow.webContents.setWindowOpenHandler(({ url }) => {
            if (!isTrustedHost(url)) {
                shell.openExternal(url);
                return { action: 'deny' };
            }
            return { action: 'allow' };
        });

        mainWindow.webContents.on('will-navigate', (event, url) => {
            if (!isTrustedHost(url)) {
                event.preventDefault();
                shell.openExternal(url);
            }
        });

        mainWindow.webContents.on('context-menu', (event, params) => {
            if (!params.misspelledWord) return;
            const menu = Menu.buildFromTemplate([
                ...params.dictionarySuggestions.map((suggestion) => ({
                    label: suggestion,
                    click: () => mainWindow.webContents.replaceMisspelling(suggestion),
                })),
                { type: 'separator' },
                {
                    label: 'Add to dictionary',
                    click: () => mainWindow.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
                },
            ]);
            menu.popup();
        });

        mainWindow.loadURL(activeUrl);

        mainWindow.on('close', (event) => {
            if (!app.isQuitting) {
                event.preventDefault();
                mainWindow.hide();
            }
            return false;
        });
    }

    function createTray() {
        try {
            tray = new Tray(getTrayIconPath());

            tray.setToolTip('Sable Client');
            tray.setContextMenu(Menu.buildFromTemplate([
                { label: 'Open Sable',     click: () => { mainWindow.show(); mainWindow.focus(); } },
                { label: 'Switch Instance', click: () => openSwitcher() },
                { type: 'separator' },
                { label: 'Quit',           click: () => { app.isQuitting = true; app.quit(); } },
            ]));

            tray.on('click', () => { mainWindow.show(); mainWindow.focus(); });
        } catch (error) {
            console.error('Failed to create tray:', error);
        }
    }

    ipcMain.handle('get-platform',  () => process.platform);
    ipcMain.handle('get-instances', () => ({ instances, activeUrl }));

    ipcMain.handle('add-instance', (_e, instance) => {
        instances.push(instance);
        saveState();
        return instances;
    });

    ipcMain.handle('remove-instance', (_e, url) => {
        instances = instances.filter(i => i.url !== url);
        saveState();
        return instances;
    });

    ipcMain.handle('switch-instance', (_e, url) => {
        activeUrl = url;
        saveState();
        mainWindow.loadURL(url);
        if (switcherWindow) switcherWindow.close();
    });

    ipcMain.handle('get-known-instances', () => KNOWN_INSTANCES);

    ipcMain.handle('select-instance', (_e, instance) => {
        if (!instances.find(i => i.url === instance.url)) instances.push(instance);
        activeUrl = instance.url;
        saveState();
        if (welcomeWindow) welcomeWindow.close();
        createWindow();
        createTray();
    });

    ipcMain.on('notify', (_event, { title, body }) => {
        const toast = new Notification({ title, body, icon: getIconPath(), silent: false });
        toast.on('click', () => {
            if (mainWindow) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.show();
                mainWindow.focus();
            }
        });
        toast.show();
    });

    app.whenReady().then(async () => {
        globalShortcut.register('CmdOrCtrl+Shift+S', openSwitcher);

        if (process.platform === 'darwin') {
            await systemPreferences.askForMediaAccess('camera');
            await systemPreferences.askForMediaAccess('microphone');
        }

        session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
            return ['media', 'microphone', 'camera', 'notifications', 'display-capture', 'fullscreen'].includes(permission);
        });

        session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
            const trusted = isTrustedHost(webContents.getURL());
            const allowed = ['media', 'microphone', 'camera', 'notifications', 'display-capture'].includes(permission);
            callback(trusted && allowed);
        });

        ipcMain.handle('get-desktop-sources', async () => {
            cachedSources = await desktopCapturer.getSources({
                types: ['screen', 'window'],
                thumbnailSize: { width: 320, height: 180 },
                fetchWindowIcons: false,
            });
            return cachedSources.map(s => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() }));
        });

        ipcMain.on('picker-result', (_event, result) => {
            const cb = pendingPickerCallback;
            pendingPickerCallback = null;
            if (pickerWindow) { pickerWindow.close(); pickerWindow = null; }
            if (cb) {
                const source = result && cachedSources.find(s => s.id === result.sourceId);
                if (source) {
                    const streams = { video: source };
                    if (result.audio && process.platform !== 'linux') streams.audio = 'loopback';
                    cb(streams);
                } else {
                    try { cb({}); } catch (_) {
                    }
                }
            }
        });

        session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
            if (process.platform === 'darwin') {
                const status = systemPreferences.getMediaAccessStatus('screen');
                if (status !== 'authorized') {
                    const { response } = await dialog.showMessageBox(mainWindow, {
                        type: 'warning',
                        title: 'Screen Recording Permission Required',
                        message: 'Sable needs screen recording access.',
                        detail: 'Please enable it in System Settings > Privacy & Security > Screen Recording, then restart Sable.',
                        buttons: ['Open System Settings', 'Cancel'],
                        defaultId: 0,
                    });
                    if (response === 0) shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
                    try { callback({}); } catch (_) {}
                    return;
                }
            }

            pendingPickerCallback = callback;
            pickerWindow = new BrowserWindow({
                width: 680,
                height: 520,
                parent: mainWindow,
                modal: true,
                resizable: false,
                title: 'Share Screen',
                webPreferences: {
                    nodeIntegration: false,
                    contextIsolation: true,
                    preload: r('preload/picker.js'),
                },
            });
            pickerWindow.removeMenu();
            pickerWindow.loadFile(r('renderer/picker.html'));
            pickerWindow.on('closed', () => {
                if (pendingPickerCallback) {
                    try { pendingPickerCallback({}); } catch (_) {}
                    pendingPickerCallback = null;
                }
                pickerWindow = null;
            });
        });

        if (isFirstRun) {
            openWelcomeWindow();
        } else {
            createWindow();
            createTray();
        }
    });

    app.on('window-all-closed', () => {
        if (process.platform !== 'darwin') app.quit();
    });

    app.on('before-quit', () => {
        app.isQuitting = true;
        globalShortcut.unregisterAll();
    });

    app.on('activate', () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    });
}
