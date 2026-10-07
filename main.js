const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { exec, spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      nodeIntegration: true, // Permite usar módulos de Node en el HTML
      contextIsolation: false // Simplifica el proyecto para empezar
    },
    // icon:'assets/icon.png'
    frame: true,
    autoHideMenuBar: true,
    center: true,

  });
    win.webContents.openDevTools();
    win.loadFile('index.html');
    iniciarMonitorADB(win); 
}

app.whenReady().then(createWindow);

ipcMain.handle('select-backup-folder', async () => {
    const result = await dialog.showOpenDialog({
        properties: ['openDirectory', 'createDirectory']
    });

    return result.canceled ? null : result.filePaths[0];
});


// --- LÓGICA DE ADB ---
const adbPath = path.join(__dirname, 'bin', 'adb.exe');
const respaldosActivos = new Map();

let dispositivoActual = null;

function iniciarMonitorADB(win) {
    setInterval(() => {
        exec(`"${adbPath}" devices`, (error, stdout) => {
            if (error) return; 
            const lineas = stdout.trim().split('\n');
            
            if (lineas.length > 1) {
                const id = lineas[1].split('\t')[0];
                
                if (dispositivoActual !== id) {
                    dispositivoActual = id;
                    win.webContents.send('estado-dispositivo', { conectado: true, id: id });
                }
            } else {
                if (dispositivoActual !== null) {
                    dispositivoActual = null;
                    win.webContents.send('estado-dispositivo', { conectado: false });
                }
            }
        });
    }, 2000);
}

ipcMain.handle('check-devices', async () => {
    return new Promise((resolve, reject) => {
        exec(`"${adbPath}" devices`, (error, stdout) => {
            if (error) {
                resolve({ success: false, msg: "ADB no ejecutado", error: error.message });
                return;
            }
            
            const lineas = stdout.trim().split('\n');
            if (lineas.length > 1) {
                // Hay un dispositivo
                resolve({ success: true, id: lineas[1].split('\t')[0] });
            } else {
                resolve({ success: false, msg: "Ningún dispositivo detectado" });
            }
        });
    });
});


ipcMain.handle('start-backup', async (event, selecciones) => {
    const senderId = event.sender.id;
    if (respaldosActivos.has(senderId)) {
        return { success: false, msg: 'Ya hay un respaldo en curso.' };
    }

    const respaldo = { cancelado: false, proceso: null };
    respaldosActivos.set(senderId, respaldo);
    try {
        return await ejecutarRespaldo(event, selecciones, respaldo);
    } finally {
        if (respaldosActivos.get(senderId) === respaldo) {
            respaldosActivos.delete(senderId);
        }
    }
});

ipcMain.handle('cancel-backup', (event) => {
    const respaldo = respaldosActivos.get(event.sender.id);
    if (!respaldo) {
        return { success: false, msg: 'No hay ningún respaldo en curso para cancelar.' };
    }

    if (respaldo.proceso && !respaldo.proceso.killed) {
        const senalEnviada = respaldo.proceso.kill();
        if (!senalEnviada) {
            return { success: false, msg: 'No se pudo detener el proceso de ADB.' };
        }
    }

    respaldo.cancelado = true;
    return { success: true, msg: 'Se solicitó cancelar el respaldo.' };
});

async function ejecutarRespaldo(event, selecciones, respaldo) {
    const nombreBackup = typeof selecciones.backupName === 'string'
        ? selecciones.backupName.trim()
        : '';
    const carpetaBase = typeof selecciones.destinationPath === 'string'
        ? selecciones.destinationPath.trim()
        : '';

    if (
        !nombreBackup ||
        /[<>:"/\\|?*\x00-\x1f]/.test(nombreBackup) ||
        /[. ]$/.test(nombreBackup) ||
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(nombreBackup)
    ) {
        return { success: false, msg: 'El nombre del backup está vacío o contiene caracteres no válidos.' };
    }

    if (!carpetaBase || !path.isAbsolute(carpetaBase)) {
        return { success: false, msg: 'Selecciona una carpeta de destino válida.' };
    }

    const carpetaDestinoPC = path.join(carpetaBase, nombreBackup);
    
    const tareas = [];
    if (selecciones.whatsapp) tareas.push({ nombre: 'WhatsApp', ruta: '/sdcard/Android/media/com.whatsapp/' });
    if (selecciones.telegram) {
        tareas.push({ nombre: 'Telegram (Descargas)', ruta: '/sdcard/Download/Telegram/' });
        tareas.push({ nombre: 'Telegram (Media)', ruta: '/sdcard/Android/media/org.telegram.messenger/' });
    }
    if (selecciones.dcim) tareas.push({ nombre: 'Cámara (DCIM)', ruta: '/sdcard/DCIM/' });
    if (selecciones.downloads) tareas.push({ nombre: 'Descargas', ruta: '/sdcard/Download/' });
    if (selecciones.extras && selecciones.extras.length > 0) {
        for (const carpeta of selecciones.extras) {
            tareas.push({ nombre: carpeta.nombre, ruta: carpeta.ruta });
        }
    }

    if (tareas.length === 0) {
        return { success: false, msg: 'Selecciona al menos una opción para respaldar.' };
    }

    try {
        await fs.mkdir(carpetaDestinoPC, { recursive: true });
    } catch (error) {
        return { success: false, msg: `No se pudo crear la carpeta del backup: ${error.message}` };
    }

    for (const [taskIndex, tarea] of tareas.entries()) {
        if (respaldo.cancelado) {
            return { success: false, cancelled: true, msg: 'Respaldo cancelado por el usuario.' };
        }

        event.sender.send('backup-progress', {
            type: 'task-start',
            taskName: tarea.nombre,
            taskIndex,
            taskCount: tareas.length
        });
        
        try {
            if (respaldo.cancelado) {
                return { success: false, cancelled: true, msg: 'Respaldo cancelado por el usuario.' };
            }

            await ejecutarComandoADB(
                tarea.ruta,
                carpetaDestinoPC,
                tarea.nombre,
                taskIndex,
                tareas.length,
                respaldo,
                event
            );
            if (respaldo.cancelado) {
                return { success: false, cancelled: true, msg: 'Respaldo cancelado por el usuario.' };
            }
            event.sender.send('backup-progress', {
                type: 'task-complete',
                taskName: tarea.nombre,
                taskIndex,
                taskCount: tareas.length
            });
        } catch (error) {
            if (respaldo.cancelado) {
                return { success: false, cancelled: true, msg: 'Respaldo cancelado por el usuario.' };
            }
            return { success: false, msg: `Falló al copiar ${tarea.nombre}: ${error.message}` };
        }
    }

    if (respaldo.cancelado) {
        return { success: false, cancelled: true, msg: 'Respaldo cancelado por el usuario.' };
    }

    return { success: true, msg: `Todos los respaldos completados en ${carpetaDestinoPC}` };
}

function ejecutarComandoADB(rutaAndroid, carpetaDestino, taskName, taskIndex, taskCount, respaldo, event) {
    return new Promise((resolve, reject) => {
        const adbProcess = spawn(adbPath, ['pull', '-a', rutaAndroid, carpetaDestino]);
        respaldo.proceso = adbProcess;
        let percentBuffer = '';

        const manejarSalida = (data) => {
            const texto = data.toString();
            const progressSample = percentBuffer + texto;
            const porcentajes = [...progressSample.matchAll(/(\d{1,3})%/g)];
            const percent = porcentajes.length
                ? Math.min(100, Number(porcentajes[porcentajes.length - 1][1]))
                : null;
            const ultimoPorcentaje = progressSample.lastIndexOf('%');
            percentBuffer = (ultimoPorcentaje >= 0
                ? progressSample.slice(ultimoPorcentaje + 1)
                : progressSample).slice(-4);

            event.sender.send('backup-progress', {
                type: 'output',
                taskName,
                taskIndex,
                taskCount,
                text: texto,
                percent
            });
        };

        adbProcess.stdout.on('data', manejarSalida);
        adbProcess.stderr.on('data', manejarSalida);
        adbProcess.once('error', (error) => {
            respaldo.proceso = null;
            reject(error);
        });

        adbProcess.on('close', (code) => {
            respaldo.proceso = null;
            if (respaldo.cancelado || code === 0) resolve();
            else reject(new Error(`Código de salida ${code}`));
        });
    });
}
ipcMain.handle('get-android-folders', async () => {
    return new Promise((resolve) => {
        exec(`"${adbPath}" shell "ls -p /sdcard/ | grep /"`, (error, stdout) => {
            if (error) {
                resolve({ success: false, carpetas: [] });
                return;
            }
            
            const carpetas = stdout.split('\n')
                .map(c => c.trim().replace('/', '')) 
                .filter(c => c.length > 0 && !c.startsWith('.')); 
            
            resolve({ success: true, carpetas: carpetas });
        });
    });
});