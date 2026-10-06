const { app, BrowserWindow, ipcMain } = require('electron');
const { exec } = require('child_process');
const path = require('path');

function createWindow() {
  const win = new BrowserWindow({
    width: 800,
    height: 600,
    webPreferences: {
      nodeIntegration: true, // Permite usar módulos de Node en el HTML
      contextIsolation: false // Simplifica el proyecto para empezar
    }
  });

  win.loadFile('index.html');
}

app.whenReady().then(createWindow);

// --- LÓGICA DE ADB ---
// Definimos la ruta de adb.exe (asumiendo que lo meterás en la carpeta 'bin')
const adbPath = path.join(__dirname, 'bin', 'adb.exe');

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
ipcMain.handle('start-backup', async () => {
    return new Promise((resolve) => {
        // Ejecutamos el pull usando la bandera -a para conservar las fechas
        // Guardaremos la carpeta en C:\WhatsApp_Backup
        const comando = `"${adbPath}" pull -a /sdcard/Android/media/com.whatsapp/ C:\\WhatsApp_Backup`;
        
        // Cuidado: Este comando tardará dependiendo del tamaño de la carpeta
        exec(comando, { maxBuffer: 1024 * 1024 * 50 }, (error, stdout, stderr) => {
            if (error) {
                resolve({ success: false, msg: error.message });
            } else {
                resolve({ success: true, msg: "Respaldo completado en C:\\WhatsApp_Backup" });
            }
        });
    });
});