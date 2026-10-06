const { ipcRenderer } = require('electron');

const btnBackup = document.getElementById('btn-backup');
const deviceStatus = document.getElementById('device-status');
const statusText = document.getElementById('status');

// 1. Revisar si hay un dispositivo al abrir la app
async function verificarDispositivo() {
    const respuesta = await ipcRenderer.invoke('check-devices');
    
    if (respuesta.success) {
        deviceStatus.innerText = `📱 Conectado: ${respuesta.id}`;
        deviceStatus.classList.add('success');
        btnBackup.disabled = false;
        statusText.innerText = "Listo para extraer archivos.";
    } else {
        deviceStatus.innerText = "Estado: Desconectado";
        deviceStatus.classList.remove('success');
        btnBackup.disabled = true;
    }
}

// Correr la revisión de inmediato
verificarDispositivo();

// 2. Darle acción al botón de Backup
btnBackup.addEventListener('click', async () => {
    btnBackup.disabled = true;
    btnBackup.innerText = "⏳ Copiando Gigabytes... Espera...";
    statusText.innerText = "No desconectes el cable por nada del mundo.";

    const respuesta = await ipcRenderer.invoke('start-backup');

    if (respuesta.success) {
        statusText.innerText = "✅ " + respuesta.msg;
        btnBackup.innerText = "⬇️ Backup Exitoso";
    } else {
        statusText.innerText = "❌ Error: " + respuesta.msg;
        btnBackup.innerText = "⬇️ Intentar de nuevo";
        btnBackup.disabled = false;
    }
});