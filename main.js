const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { exec, spawn } = require('child_process');
const fs = require('fs/promises');
const path = require('path');
const https = require('https');
const { createWriteStream } = require('fs'); 

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
ipcMain.handle('get-backups-list', async (event, carpetaBase) => {
    try {
        const elementos = await fs.readdir(carpetaBase, { withFileTypes: true });
        const carpetas = elementos
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
        carpetas.reverse(); 

        return { success: true, respaldos: carpetas };
    } catch (error) {
        return { success: false, msg: error.message };
    }
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
    
    const agregarTarea = (nombre, rutaAndroid, rutaPadrePCOverride) => {
        const rutaRelativa = rutaAndroid.replace(/^\/sdcard\//, '').replace(/\/$/, '');
        const partes = rutaRelativa.split('/');
        partes.pop(); // La ruta local usa el directorio padre del origen
        const rutaPadrePC = rutaPadrePCOverride ?? partes.join('/');
        
        tareas.push({ nombre, rutaAndroid, rutaPadrePC });
    };

    if (selecciones.whatsapp) agregarTarea('WhatsApp', '/sdcard/Android/media/com.whatsapp/');
    if (selecciones.telegram) {
        agregarTarea('Telegram (Descargas)', '/sdcard/Download/Telegram/');
        agregarTarea('Telegram (Imágenes)', '/sdcard/Pictures/Telegram/');
        agregarTarea('Telegram (Videos)', '/sdcard/Movies/Telegram/');
    }
    if (selecciones.dcim) agregarTarea('Cámara (DCIM)', '/sdcard/DCIM/');
    if (selecciones.downloads) agregarTarea('Descargas', '/sdcard/Download/', '');
    
    if (selecciones.extras && selecciones.extras.length > 0) {
        for (const carpeta of selecciones.extras) {
            agregarTarea(carpeta.nombre, carpeta.ruta);
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
        const destinoFinalPC = path.join(carpetaDestinoPC, tarea.rutaPadrePC.replace(/\//g, path.sep));
        await fs.mkdir(destinoFinalPC, { recursive: true });

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
                destinoFinalPC,
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
            if (respaldo.cancelado) {
                resolve();
            } else if (code === 0) {
                resolve();
            } else {
                console.log(`La tarea ${taskName} devolvió código ${code} (Probablemente no existe). Omitiendo...`);
                resolve(); 
            }
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
ipcMain.handle('start-restore', async (event, datos) => {
    const { rutaRespaldoPC } = datos;
    
    try {
        const elementos = await fs.readdir(rutaRespaldoPC, { withFileTypes: true });
        const carpetasPrincipales = elementos.filter(e => e.isDirectory());
        
        for (let i = 0; i < carpetasPrincipales.length; i++) {
            const nombreCarpeta = carpetasPrincipales[i].name; 
            const rutaLocalPC = path.join(rutaRespaldoPC, nombreCarpeta);
            
            event.sender.send('backup-progress', { 
                type: 'task-start', taskName: `Inyectando ${nombreCarpeta}...`, taskIndex: i, taskCount: carpetasPrincipales.length 
            });
            
            await ejecutarPushADB(rutaLocalPC, '/sdcard/', nombreCarpeta, i, carpetasPrincipales.length, event);
            
            event.sender.send('backup-progress', { 
                type: 'task-complete', taskName: nombreCarpeta, taskIndex: i, taskCount: carpetasPrincipales.length 
            });
        }

        const rutaWaPC = path.join(rutaRespaldoPC, 'Android', 'media', 'com.whatsapp');
        try {
            await fs.access(rutaWaPC); // Revisamos si la carpeta existe
            
            event.sender.send('backup-progress', { 
                type: 'task-start', taskName: 'Configurando WhatsApp...', taskIndex: carpetasPrincipales.length, taskCount: carpetasPrincipales.length + 1 
            });
            
            await configurarWhatsApp(event, carpetasPrincipales.length, carpetasPrincipales.length + 1);
            
            event.sender.send('backup-progress', { 
                type: 'task-complete', taskName: 'WhatsApp Configurado', taskIndex: carpetasPrincipales.length, taskCount: carpetasPrincipales.length + 1 
            });
        } catch (e) {
            console.log("No había WhatsApp en este respaldo.");
        }
        
        return { success: true, msg: "Restauración finalizada exitosamente." };
        
    } catch (error) {
        return { success: false, msg: error.message };
    }
});

// Función auxiliar para empujar (Push) a Android
function ejecutarPushADB(rutaPC, destinoAndroid, taskName, taskIndex, taskCount, event) {
    return new Promise((resolve, reject) => {
        const adbProcess = spawn(adbPath, ['push', rutaPC, destinoAndroid]);
        let percentBuffer = '';

        const manejarSalida = (data) => {
            const texto = data.toString();
            const progressSample = percentBuffer + texto;
            const porcentajes = [...progressSample.matchAll(/(\d{1,3})%/g)];
            const percent = porcentajes.length ? Math.min(100, Number(porcentajes[porcentajes.length - 1][1])) : null;
            const ultimoPorcentaje = progressSample.lastIndexOf('%');
            percentBuffer = (ultimoPorcentaje >= 0 ? progressSample.slice(ultimoPorcentaje + 1) : progressSample).slice(-4);

            event.sender.send('backup-progress', {
                type: 'output', taskName, taskIndex, taskCount, text: texto, percent
            });
        };

        adbProcess.stdout.on('data', manejarSalida);
        adbProcess.stderr.on('data', manejarSalida);
        
        adbProcess.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Falló con código ${code}`));
        });
    });
}
// Función para Instalar y Dar Permisos a WhatsApp
async function configurarWhatsApp(event, taskIndex, taskCount) {
    const execShell = (comando) => new Promise((resolve) => exec(comando, (err, stdout) => resolve({err, stdout})));

    // 1. Revisar si WhatsApp ya está en el celular
    const check = await execShell(`"${adbPath}" shell pm list packages com.whatsapp`);
    
    if (!check.stdout.includes('com.whatsapp')) {
        const apkPath = path.join(__dirname, 'bin', 'whatsapp.apk');
        const urlDescarga = "https://aqui-pones-el-enlace-de-tu-github.com/whatsapp.apk"; 

        try {
            await fs.access(apkPath);
            event.sender.send('backup-progress', { type: 'output', text: 'Usando instalador almacenado en caché...', percent: 100 });
        } catch (e) {
            event.sender.send('backup-progress', { type: 'output', text: 'Conectando al servidor para descargar WhatsApp...' });
            
            await descargarAPK(urlDescarga, apkPath, event, 'Descargando WhatsApp', taskIndex, taskCount);
        }

        event.sender.send('backup-progress', { type: 'output', text: 'Instalando en Android... (Esto puede tardar unos minutos)' });
        await execShell(`"${adbPath}" install -r "${apkPath}"`);
    }

    event.sender.send('backup-progress', { type: 'output', text: 'Inyectando permisos de almacenamiento...' });
    
    await execShell(`"${adbPath}" shell pm grant com.whatsapp android.permission.READ_MEDIA_IMAGES`);
    await execShell(`"${adbPath}" shell pm grant com.whatsapp android.permission.READ_MEDIA_VIDEO`);
    await execShell(`"${adbPath}" shell pm grant com.whatsapp android.permission.READ_MEDIA_AUDIO`);
    await execShell(`"${adbPath}" shell pm grant com.whatsapp android.permission.READ_EXTERNAL_STORAGE`);
    await execShell(`"${adbPath}" shell pm grant com.whatsapp android.permission.WRITE_EXTERNAL_STORAGE`);
    
    event.sender.send('backup-progress', { type: 'output', text: 'Permisos aplicados. WhatsApp listo.' });
}
// Función para descargar con barra de progreso
function descargarAPK(url, rutaDestino, event, taskName, taskIndex, taskCount) {
    return new Promise((resolve, reject) => {
        const archivo = createWriteStream(rutaDestino);

        https.get(url, (respuesta) => {
            if (respuesta.statusCode === 301 || respuesta.statusCode === 302) {
                return descargarAPK(respuesta.headers.location, rutaDestino, event, taskName, taskIndex, taskCount)
                    .then(resolve).catch(reject);
            }

            if (respuesta.statusCode !== 200) {
                return reject(new Error(`Fallo en la descarga. Código HTTP: ${respuesta.statusCode}`));
            }

            const tamañoTotal = parseInt(respuesta.headers['content-length'], 10);
            let descargado = 0;

            respuesta.on('data', (chunk) => {
                descargado += chunk.length;
                if (tamañoTotal) {
                    const porcentaje = Math.round((descargado / tamañoTotal) * 100);
                    
                    event.sender.send('backup-progress', {
                        type: 'output',
                        taskName: taskName,
                        taskIndex: taskIndex,
                        taskCount: taskCount,
                        text: `Descargando APK de WhatsApp... ${porcentaje}%`,
                        percent: porcentaje
                    });
                }
            });

            respuesta.pipe(archivo);

            archivo.on('finish', () => {
                archivo.close();
                resolve();
            });
        }).on('error', (err) => {
            archivo.close();
            resolve(); 
        });
    });
}