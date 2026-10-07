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
const rutaGuardada = localStorage.getItem('rutaRespaldoGuardada');
if (rutaGuardada) {
    backupPathInput.value = rutaGuardada;
}
const tabBackup = document.getElementById('tab-backup');
const tabRestore = document.getElementById('tab-restore');
const vistaBackup = document.getElementById('vista-backup');
const vistaRestore = document.getElementById('vista-restore');
const listaRespaldos = document.getElementById('lista-respaldos');
// Variable global para saber en qué modo estamos y qué respaldo eligió
let modoActual = 'backup';
let respaldoSeleccionado = '';



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
            localStorage.setItem('backupPath', carpeta);
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


// --- EVENTO: Cambiar a Restaurar ---
tabRestore.addEventListener('click', async () => {
    modoActual = 'restore';
    
    // Cambios visuales en las pestañas
    tabBackup.style.borderColor = 'transparent';
    tabBackup.style.color = '#aaa';
    tabRestore.style.borderColor = '#0078D7';
    tabRestore.style.color = 'white';
    
    // Intercambio de Vistas
    vistaBackup.style.display = 'none';
    vistaRestore.style.display = 'block';
    
    // Cambiamos el botón principal de la derecha
    btnBackup.innerText = 'Restaurar Backup';
    btnBackup.style.backgroundColor = '#2b8a3e'; // Verde para que el usuario note el cambio
    
    // Disparamos la lectura de carpetas
    await cargarListaRespaldos();
});

// --- EVENTO: Cambiar a Respaldar ---
tabBackup.addEventListener('click', () => {
    modoActual = 'backup';
    
    // Cambios visuales
    tabRestore.style.borderColor = 'transparent';
    tabRestore.style.color = '#aaa';
    tabBackup.style.borderColor = '#0078D7';
    tabBackup.style.color = 'white';
    
    vistaRestore.style.display = 'none';
    vistaBackup.style.display = 'block';
    
    // Regresamos el botón a la normalidad
    btnBackup.innerText = 'Realizar Backup';
    btnBackup.style.backgroundColor = '#0078D7';
});

// --- FUNCIÓN: Llenar la lista de respaldos ---
async function cargarListaRespaldos() {
    const carpetaBase = backupPathInput.value;
    
    if (!carpetaBase) {
        listaRespaldos.innerHTML = '<p style="padding: 15px; color: #ff6b6b; text-align: center;">Primero selecciona la Ubicación base en la tarjeta derecha.</p>';
        return;
    }

    const respuesta = await ipcRenderer.invoke('get-backups-list', carpetaBase);
    
    if (respuesta.success && respuesta.respaldos.length > 0) {
        listaRespaldos.innerHTML = ''; // Limpiamos la lista
        
        respuesta.respaldos.forEach(nombreRespaldo => {
            const item = document.createElement('div');
            item.style.padding = '12px 15px';
            item.style.borderBottom = '1px solid #333';
            item.style.cursor = 'pointer';
            item.style.transition = 'background-color 0.2s';
            item.innerText = `📦 ${nombreRespaldo}`;
            
            item.addEventListener('mouseover', () => { if (respaldoSeleccionado !== nombreRespaldo) item.style.backgroundColor = '#2a2a2a'; });
            item.addEventListener('mouseout', () => { if (respaldoSeleccionado !== nombreRespaldo) item.style.backgroundColor = 'transparent'; });
            
            item.addEventListener('click', () => {
                Array.from(listaRespaldos.children).forEach(hijo => hijo.style.backgroundColor = 'transparent');
                item.style.backgroundColor = '#005A9E';
                respaldoSeleccionado = nombreRespaldo;
            });
            
            listaRespaldos.appendChild(item);
        });
    } else {
        listaRespaldos.innerHTML = '<p style="padding: 15px; color: #aaa; text-align: center;">No se encontraron respaldos en esta ruta.</p>';
    }
}

btnBackup.addEventListener('click', async () => {
    if (modoActual === 'restore') {
        if (!respaldoSeleccionado) {
            setStatus("Selecciona un respaldo de la lista primero.", 'error');
            return;
        }
        
        const rutaCompletaRespaldo = `${backupPathInput.value}\\${respaldoSeleccionado}`;
        
        bloquearControles(true);
        setStatus(`Restaurando desde: ${respaldoSeleccionado}`);
        progressContainer.classList.add('progress-visible');
        progresoTexto.innerText = '';
        progressBar.classList.remove('progress-error', 'progress-cancelled');
        setProgress(0, "Iniciando Restauración...");
        
        const respuesta = await ipcRenderer.invoke('start-restore', { rutaRespaldoPC: rutaCompletaRespaldo });
        
        bloquearControles(false);
        if (respuesta.success) {
            setStatus("Restauración Completada", 'success');
            setProgress(100, respuesta.msg);
        } else {
            setStatus(`Error: ${respuesta.msg}`, 'error');
            progressBar.classList.add('progress-error');
        }
        return; 
    }

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
