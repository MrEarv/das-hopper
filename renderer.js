const { ipcRenderer } = require('electron'); 

const btnBackup = document.getElementById('backup-btn'); 
//const btnRestore = document.getElementById('restore-btn');
const deviceStatus = document.getElementById('device-status');
const statusText = document.getElementById('status');
const phoneCard = document.getElementById('celular_status');
const backupNameInput = document.getElementById('backup-name');
const backupPathInput = document.getElementById('backup-path');
const selectBackupPathButton = document.getElementById('select-backup-path');
const progressBar = document.getElementById('progress-bar');
const progressText = document.getElementById('progress-text');
const progressBarContainer = document.getElementById('progress-bar-container');
const progressContainer = document.getElementById('progress-container');
let dispositivoIdActual = '';
let respaldoEnCurso = false;
let cancelacionEnCurso = false;
let estadosControlesPrevios = new Map();

function bloquearControles(bloquear) {
    respaldoEnCurso = bloquear;
    document.body.classList.toggle('backup-running', bloquear);

    if (bloquear) {
        estadosControlesPrevios = new Map();
        document.querySelectorAll('button, input, select').forEach((control) => {
            estadosControlesPrevios.set(control, control.disabled);
            control.disabled = true;
        });
        return;
    }

    estadosControlesPrevios.forEach((estabaDeshabilitado, control) => {
        if (!control.isConnected) return;
        control.disabled = control.id === 'backup-btn'
            ? estabaDeshabilitado || !dispositivoIdActual
            : estabaDeshabilitado;
    });
    estadosControlesPrevios.clear();
}

async function cancelarRespaldo() {
    if (cancelacionEnCurso) return;

    cancelacionEnCurso = true;
    btnBackup.disabled = true;
    btnBackup.innerText = "Cancelando...";
    setStatus("Cancelando el respaldo. Espera a que ADB se detenga.");
    progressText.innerText = "Cancelando respaldo...";

    try {
        const resultado = await ipcRenderer.invoke('cancel-backup');
        if (!resultado.success && respaldoEnCurso) {
            cancelacionEnCurso = false;
            btnBackup.disabled = false;
            btnBackup.innerText = "Cancelar respaldo";
            setStatus(resultado.msg, 'error');
        }
    } catch (error) {
        if (respaldoEnCurso) {
            cancelacionEnCurso = false;
            btnBackup.disabled = false;
            btnBackup.innerText = "Cancelar respaldo";
            setStatus(`No se pudo cancelar el respaldo: ${error.message}`, 'error');
        }
    }
}

function setStatus(message, type = 'info') {
    statusText.innerText = message;
    statusText.classList.remove('status-error', 'status-success', 'status-info');
    statusText.classList.add(`status-${type}`);
}

function setProgress(percent, message, active = false) {
    const boundedPercent = Math.max(0, Math.min(100, percent));
    progressBar.style.width = `${boundedPercent}%`;
    progressBar.classList.toggle('progress-active', active);
    progressBarContainer.classList.toggle('progress-running', active);
    progressBarContainer.setAttribute('aria-valuenow', String(boundedPercent));
    progressBarContainer.setAttribute('aria-valuetext', message);
    progressText.innerText = message;
}

function generarNombreBackup(idDispositivo, fecha = new Date()) {
    const idSeguro = idDispositivo.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
    const fechaLocal = [
        fecha.getFullYear(),
        String(fecha.getMonth() + 1).padStart(2, '0'),
        String(fecha.getDate()).padStart(2, '0')
    ].join('-');

    return `Respaldo_${idSeguro}_${fechaLocal}`;
}

selectBackupPathButton.addEventListener('click', async () => {
    try {
        const carpeta = await ipcRenderer.invoke('select-backup-folder');
        if (carpeta) {
            backupPathInput.value = carpeta;
        }
    } catch (error) {
        setStatus(`No se pudo seleccionar la carpeta: ${error.message}`, 'error');
    }
});

// Arreglo para guardar las carpetas que el usuario va apilando
let carpetasExtra = [];
const btnAddFolder = document.getElementById('btn-add-folder');
const contenedorApiladas = document.getElementById('carpetas-apiladas');
const selectFolders = document.getElementById('android-folders-list');

// Evento para el botón de "➕ Añadir"
btnAddFolder.addEventListener('click', () => {
    const ruta = selectFolders.value;
    const nombre = selectFolders.options[selectFolders.selectedIndex]?.text;

    if (!ruta || ruta === "") return;

    const yaExiste = carpetasExtra.find(c => c.ruta === ruta);
    if (yaExiste) return;

    carpetasExtra.push({ nombre: nombre, ruta: ruta });
    
    renderizarCarpetas();
});

function renderizarCarpetas() {
    contenedorApiladas.innerHTML = ''; 
    
    carpetasExtra.forEach((carpeta, index) => {
        const badge = document.createElement('div');
        badge.className = 'folder-badge';
        badge.innerHTML = `
            <span>📁 ${carpeta.nombre}</span>
            <span class="quitar" title="Quitar">✖</span>
        `;

        badge.querySelector('.quitar').addEventListener('click', () => {
            carpetasExtra.splice(index, 1); 
            renderizarCarpetas(); 
        });

        contenedorApiladas.appendChild(badge);
    });
}

ipcRenderer.on('estado-dispositivo', (event, data) => {
    
    if (data.conectado) {
        dispositivoIdActual = String(data.id || '');
        phoneCard.classList.add('device-connected');
        deviceStatus.innerText = `📱 Conectado: ${data.id}`;
        deviceStatus.classList.add('success');
        
        btnBackup.disabled = respaldoEnCurso && cancelacionEnCurso;
        
        setStatus("Dispositivo detectado. Listo para operar.", 'success');
        cargarCarpetasAndroid(); 
        
    } else {

        dispositivoIdActual = '';
        phoneCard.classList.remove('device-connected');
        deviceStatus.innerText = "Estado: Buscando dispositivo...";
        deviceStatus.classList.remove('success');
        
        btnBackup.disabled = respaldoEnCurso ? cancelacionEnCurso : true;
        //btnRestore.disabled = true;
        
        setStatus("Por favor, conecta tu dispositivo y activa la Depuración USB.");
        document.getElementById('android-folders-list').innerHTML = '<option value="">Esperando dispositivo...</option>';
    }
});

btnBackup.addEventListener('click', async () => {
    if (respaldoEnCurso) {
        await cancelarRespaldo();
        return;
    }

    if (!dispositivoIdActual) {
        setStatus("No se detectó el ID del dispositivo.", 'error');
        return;
    }

    const nombreBackup = backupNameInput.value.trim() || generarNombreBackup(dispositivoIdActual);
    const carpetaDestino = backupPathInput.value;

    if (!carpetaDestino) {
        setStatus("Selecciona la carpeta de destino.", 'error');
        return;
    }

    const selecciones = {
        whatsapp: document.getElementById('whatsapp-data').checked,
        telegram: document.getElementById('telegram-data').checked,
        dcim: document.getElementById('dcim-data').checked,
        downloads: document.getElementById('downloads-data').checked,
        extras: carpetasExtra,
        backupName: nombreBackup,
        destinationPath: carpetaDestino
    };

    if (!selecciones.whatsapp && !selecciones.telegram && !selecciones.dcim && !selecciones.downloads && !selecciones.extras.length) {
        setStatus("Selecciona al menos una opción para respaldar.", 'error');
        return;
    }

    bloquearControles(true);
    cancelacionEnCurso = false;
    btnBackup.disabled = false;
    btnBackup.innerText = "Cancelar respaldo";
    btnBackup.classList.add('cancel-backup');
    setStatus("No desconectes el cable durante el respaldo.");
    progressContainer.classList.add('progress-visible');
    progresoTexto.innerText = '';
    progressBar.classList.remove('progress-error', 'progress-cancelled');
    setProgress(0, "Preparando respaldo...");

    let respuesta;
    try {
        respuesta = await ipcRenderer.invoke('start-backup', selecciones);
    } catch (error) {
        respuesta = { success: false, msg: error.message };
    }

    btnBackup.classList.remove('cancel-backup');
    if (respuesta.cancelled) {
        setStatus("Respaldo cancelado.", 'info');
        btnBackup.innerText = "Realizar Backup";
        progressBar.classList.add('progress-cancelled');
        setProgress(Number(progressBarContainer.getAttribute('aria-valuenow')), "Respaldo cancelado");
    } else if (respuesta.success) {
        setStatus("Completado", 'success');
        btnBackup.innerText = "Backup exitoso";
        setProgress(100, respuesta.msg);
    } else {
        setStatus(`Error: ${respuesta.msg}`, 'error');
        btnBackup.innerText = "Intentar de nuevo";
        progressBar.classList.add('progress-error');
        setProgress(Number(progressBarContainer.getAttribute('aria-valuenow')), "El respaldo no se completó");
    }
    cancelacionEnCurso = false;
    bloquearControles(false);
});

const progresoTexto = document.getElementById('backup-status');
ipcRenderer.on('backup-progress', (event, update) => {
    if (update.type === 'task-start') {
        progresoTexto.innerText = `Respaldando: ${update.taskName}`;
        const completedPercent = (update.taskIndex / update.taskCount) * 100;
        setProgress(
            completedPercent,
            `Categoría ${update.taskIndex + 1} de ${update.taskCount}: ${update.taskName}`,
            true
        );
        return;
    }

    if (update.type === 'task-complete') {
        const completedPercent = ((update.taskIndex + 1) / update.taskCount) * 100;
        setProgress(
            completedPercent,
            `Categoría ${update.taskIndex + 1} de ${update.taskCount} completada`
        );
        return;
    }

    if (update.type === 'output') {
        const lineas = update.text.trim().split(/[\r\n]+/).filter(Boolean);
        const linea = lineas[lineas.length - 1];
        if (linea) {
            progresoTexto.innerText = linea;
        }

        if (Number.isFinite(update.percent)) {
            progressText.innerText = `Categoría ${update.taskIndex + 1} de ${update.taskCount}: ${update.taskName}`;
            progresoTexto.innerText = `Archivo actual: ${update.percent}%`;
        }
    }
});

async function cargarCarpetasAndroid() {
    const selectBox = document.getElementById('android-folders-list');
    selectBox.innerHTML = '<option value="">Cargando...</option>';
    
    const respuesta = await ipcRenderer.invoke('get-android-folders');
    
    if (respuesta.success && respuesta.carpetas.length > 0) {
        selectBox.innerHTML = ''; 
        
        respuesta.carpetas.forEach(carpeta => {
            const opcion = document.createElement('option');
            opcion.value = `/sdcard/${carpeta}/`; 
            opcion.innerText = carpeta;
            selectBox.appendChild(opcion);
        });
    } else {
        selectBox.innerHTML = '<option value="">Error al leer almacenamiento</option>';
    }
}
