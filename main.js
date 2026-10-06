const { app, BrowserWindow, ipcMain } = require('electron');
const { exec, spawn } = require('child_process');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
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


// --- LÓGICA DE ADB ---
const adbPath = path.join(__dirname, 'bin', 'adb.exe');

// Variable para recordar el estado anterior y no enviar mensajes repetidos
let dispositivoActual = null;

function iniciarMonitorADB(win) {
    // setInterval ejecuta este código cada 2000 milisegundos (2 segundos)
    setInterval(() => {
        exec(`"${adbPath}" devices`, (error, stdout) => {
            if (error) return; // Ignoramos errores silenciosos si ADB está ocupado
            
            const lineas = stdout.trim().split('\n');
            
            // Si hay más de 1 línea, significa que hay un dispositivo conectado
            if (lineas.length > 1) {
                const id = lineas[1].split('\t')[0];
                
                // Si el ID es nuevo (acaba de conectarse o se conectó uno diferente)
                if (dispositivoActual !== id) {
                    dispositivoActual = id;
                    // ¡Aquí disparamos nuestro evento personalizado hacia el HTML!
                    win.webContents.send('estado-dispositivo', { conectado: true, id: id });
                }
            } else {
                // Si no hay líneas, pero antes sí había uno (se acaba de desconectar)
                if (dispositivoActual !== null) {
                    dispositivoActual = null;
                    // Disparamos el evento avisando que se desconectó
                    win.webContents.send('estado-dispositivo', { conectado: false });
                }
            }
        });
    }, 2000);
}

// Escuchamos cuando la interfaz gráfica pida revisar dispositivos
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


// Escuchamos cuando la interfaz gráfica pida iniciar el Backup
ipcMain.handle('start-backup', async (event, selecciones) => {
    // Definimos dónde se guardará todo en la PC
    const carpetaDestinoPC = 'C:\\DasHopper_Backups';
    
    
    // Creamos la lista de tareas basada en lo que el usuario palomeó
    const tareas = [];
    if (selecciones.whatsapp) tareas.push({ nombre: 'WhatsApp', ruta: '/sdcard/Android/media/com.whatsapp/' });
    if (selecciones.telegram) tareas.push({ nombre: 'Telegram', ruta: '/sdcard/Telegram/' }); // o /sdcard/Android/media/org.telegram.messenger/ dependiendo de la app
    if (selecciones.dcim) tareas.push({ nombre: 'Cámara (DCIM)', ruta: '/sdcard/DCIM/' });
    if (selecciones.downloads) tareas.push({ nombre: 'Descargas', ruta: '/sdcard/Download/' });
    if (selecciones.extras && selecciones.extras.length > 0) {
        for (const carpeta of selecciones.extras) {
            tareas.push({ nombre: carpeta.nombre, ruta: carpeta.ruta });
        }
    }

    // Ejecutamos cada respaldo uno por uno de forma asíncrona
    for (const tarea of tareas) {
        event.sender.send('backup-progress', `\n📦 Iniciando respaldo de: ${tarea.nombre}...`);
        
        try {
            await ejecutarComandoADB(tarea.ruta, carpetaDestinoPC, event);
        } catch (error) {
            return { success: false, msg: `Falló al copiar ${tarea.nombre}: ${error.message}` };
        }
    }

    return { success: true, msg: `Todos los respaldos completados en ${carpetaDestinoPC}` };
});

// Función auxiliar que envuelve a ADB en una Promesa para que podamos usar 'await' en el bucle
function ejecutarComandoADB(rutaAndroid, carpetaDestino, event) {
    return new Promise((resolve, reject) => {
        // Ejecutamos ADB Pull
        const adbProcess = spawn(adbPath, ['pull', '-a', rutaAndroid, carpetaDestino]);

        // Escuchamos los porcentajes y los mandamos al HTML
        adbProcess.stdout.on('data', (data) => {
            event.sender.send('backup-progress', data.toString());
        });

        // Manejamos errores en la consola
        adbProcess.stderr.on('data', (data) => {
            console.error(`Advertencia ADB: ${data.toString()}`);
        });

        // Cuando termina de descargar esta carpeta específica
        adbProcess.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Código de salida ${code}`));
        });
    });
}
// Este canal pide la lista de carpetas dentro de la memoria interna
ipcMain.handle('get-android-folders', async () => {
    return new Promise((resolve) => {
        // Usamos comandos de shell de Linux:
        // "ls -p" lista archivos y pone un '/' al final de las carpetas.
        // "grep /" filtra para que solo nos devuelva las carpetas y no archivos sueltos.
        exec(`"${adbPath}" shell "ls -p /sdcard/ | grep /"`, (error, stdout) => {
            if (error) {
                resolve({ success: false, carpetas: [] });
                return;
            }
            
            // Limpiamos el texto que devuelve la consola
            const carpetas = stdout.split('\n')
                .map(c => c.trim().replace('/', '')) // Quitamos el '/' final y espacios
                .filter(c => c.length > 0 && !c.startsWith('.')); // Ignoramos ocultos (que empiezan con punto) y líneas vacías
            
            resolve({ success: true, carpetas: carpetas });
        });
    });
});