const { ipcRenderer } = require('electron');
const path = require('path');

// ---------------------------------------------------------------------------
// Elementos
// ---------------------------------------------------------------------------
const btnBackup = document.getElementById('backup-btn');
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
const progresoTexto = document.getElementById('backup-status');

const tabBackup = document.getElementById('tab-backup');
const tabRestore = document.getElementById('tab-restore');
const vistaBackup = document.getElementById('vista-backup');
const vistaRestore = document.getElementById('vista-restore');
const listaRespaldos = document.getElementById('lista-respaldos');

const btnAddFolder = document.getElementById('btn-add-folder');
const contenedorApiladas = document.getElementById('carpetas-apiladas');
const selectFolders = document.getElementById('android-folders-list');

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------
const CLAVE_RUTA = 'rutaRespaldoGuardada';

let dispositivoIdActual = '';
let operacionEnCurso = null; // 'backup' | 'restore' | null
let cancelacionEnCurso = false;
let estadosControlesPrevios = new Map();
let modoActual = 'backup';
let respaldoSeleccionado = '';
let carpetasExtra = [];
let ultimoPorcentaje = 0;

try {
    const rutaGuardada = localStorage.getItem(CLAVE_RUTA) || localStorage.getItem('backupPath');
    if (rutaGuardada) backupPathInput.value = rutaGuardada;
} catch (e) { /* localStorage no disponible */ }

// ---------------------------------------------------------------------------
// UI: estado, progreso, botón
// ---------------------------------------------------------------------------
function setStatus(message, type = 'info') {
    statusText.innerText = message;
    statusText.classList.remove('status-error', 'status-success', 'status-info', 'status-warning');
    statusText.classList.add(`status-${type}`);
}

function setProgress(percent, message, active = false) {
    const acotado = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
    ultimoPorcentaje = acotado;
    progressBar.style.width = `${acotado}%`;
    progressBar.classList.toggle('progress-active', active);
    progressBarContainer.classList.toggle('progress-running', active);
    progressBarContainer.setAttribute('aria-valuenow', String(Math.round(acotado)));
    progressBarContainer.setAttribute('aria-valuetext', message);
    progressText.innerText = message;
}

function actualizarBoton() {
    const enOperacion = operacionEnCurso !== null;
    btnBackup.classList.toggle('cancel-backup', enOperacion);
    btnBackup.classList.toggle('restore-mode', !enOperacion && modoActual === 'restore');

    if (enOperacion) {
        btnBackup.disabled = cancelacionEnCurso;
        btnBackup.innerText = cancelacionEnCurso
            ? 'Cancelando...'
            : (operacionEnCurso === 'restore' ? 'Cancelar restauración' : 'Cancelar respaldo');
    } else {
        btnBackup.disabled = !dispositivoIdActual;
        btnBackup.innerText = modoActual === 'restore' ? 'Restaurar Backup' : 'Realizar Backup';
    }
}

function bloquearControles(bloquear) {
    document.body.classList.toggle('backup-running', bloquear);

    if (bloquear) {
        estadosControlesPrevios = new Map();
        document.querySelectorAll('button, input, select').forEach((control) => {
            if (control === btnBackup) return; // el botón principal pasa a ser "Cancelar"
            estadosControlesPrevios.set(control, control.disabled);
            control.disabled = true;
        });
        return;
    }

    estadosControlesPrevios.forEach((estabaDeshabilitado, control) => {
        if (control.isConnected) control.disabled = estabaDeshabilitado;
    });
    estadosControlesPrevios.clear();
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function generarNombreBackup(idDispositivo, fecha = new Date()) {
    const idSeguro = idDispositivo.replace(/[<>:"/\\|?*\x00-\x1f\s]/g, '_');
    const dos = (n) => String(n).padStart(2, '0');
    const fechaLocal = `${fecha.getFullYear()}-${dos(fecha.getMonth() + 1)}-${dos(fecha.getDate())}`;
    const horaLocal = `${dos(fecha.getHours())}-${dos(fecha.getMinutes())}`;
    return `Respaldo_${idSeguro}_${fechaLocal}_${horaLocal}`;
}

const nombreArchivo = (ruta) => String(ruta).split(/[\\/]/).pop();

function crearMensajeLista(texto, clase = '') {
    const p = document.createElement('p');
    p.className = `lista-mensaje ${clase}`.trim();
    p.textContent = texto;
    return p;
}

// ---------------------------------------------------------------------------
// Ubicación del respaldo
// ---------------------------------------------------------------------------
selectBackupPathButton.addEventListener('click', async () => {
    try {
        const carpeta = await ipcRenderer.invoke('select-backup-folder');
        if (carpeta) {
            backupPathInput.value = carpeta;
            try { localStorage.setItem(CLAVE_RUTA, carpeta); } catch (e) { /* ignorar */ }
            if (modoActual === 'restore') await cargarListaRespaldos();
        }
    } catch (error) {
        setStatus(`No se pudo seleccionar la carpeta: ${error.message}`, 'error');
    }
});

// ---------------------------------------------------------------------------
// Carpetas extra
// ---------------------------------------------------------------------------
btnAddFolder.addEventListener('click', () => {
    if (operacionEnCurso) return;

    const ruta = selectFolders.value;
    const nombre = selectFolders.options[selectFolders.selectedIndex]?.text;
    if (!ruta) return;
    if (carpetasExtra.some((c) => c.ruta === ruta)) return;

    carpetasExtra.push({ nombre, ruta });
    renderizarCarpetas();
});

function renderizarCarpetas() {
    contenedorApiladas.replaceChildren();

    carpetasExtra.forEach((carpeta) => {
        const badge = document.createElement('div');
        badge.className = 'folder-badge';

        const etiqueta = document.createElement('span');
        etiqueta.textContent = `📁 ${carpeta.nombre}`; // textContent: evita inyección de HTML

        const quitar = document.createElement('span');
        quitar.className = 'quitar';
        quitar.title = 'Quitar';
        quitar.textContent = '✖';
        quitar.addEventListener('click', () => {
            if (operacionEnCurso) return;
            carpetasExtra = carpetasExtra.filter((c) => c.ruta !== carpeta.ruta);
            renderizarCarpetas();
        });

        badge.append(etiqueta, quitar);
        contenedorApiladas.appendChild(badge);
    });
}

async function cargarCarpetasAndroid() {
    selectFolders.innerHTML = '<option value="">Cargando...</option>';

    const respuesta = await ipcRenderer.invoke('get-android-folders');

    if (respuesta.success && respuesta.carpetas.length > 0) {
        selectFolders.replaceChildren();
        respuesta.carpetas.forEach((carpeta) => {
            const opcion = document.createElement('option');
            opcion.value = `/sdcard/${carpeta}/`;
            opcion.textContent = carpeta;
            selectFolders.appendChild(opcion);
        });
    } else {
        selectFolders.innerHTML = '<option value="">Error al leer almacenamiento</option>';
    }
}

// ---------------------------------------------------------------------------
// Estado del dispositivo
// ---------------------------------------------------------------------------
const MENSAJES_DESCONEXION = {
    unauthorized: 'Autoriza la depuración USB en la pantalla del teléfono.',
    offline: 'El dispositivo aparece sin conexión. Reconecta el cable.',
    'adb-error': 'No se pudo ejecutar ADB. Verifica que exista bin/adb.exe.'
};

ipcRenderer.on('estado-dispositivo', (event, data) => {
    if (data.conectado) {
        dispositivoIdActual = String(data.id || '');
        phoneCard.classList.add('device-connected');
        deviceStatus.innerText = `📱 Conectado: ${data.id}`;
        deviceStatus.classList.add('success');

        if (!operacionEnCurso) setStatus('Dispositivo detectado. Listo para operar.', 'success');
        cargarCarpetasAndroid();
    } else {
        dispositivoIdActual = '';
        phoneCard.classList.remove('device-connected');
        deviceStatus.innerText = 'Estado: Buscando dispositivo...';
        deviceStatus.classList.remove('success');

        if (!operacionEnCurso) {
            setStatus(
                MENSAJES_DESCONEXION[data.estado] || 'Por favor, conecta tu dispositivo y activa la Depuración USB.',
                MENSAJES_DESCONEXION[data.estado] ? 'error' : 'info'
            );
        }
        selectFolders.innerHTML = '<option value="">Esperando dispositivo...</option>';
    }
    actualizarBoton();
});

// ---------------------------------------------------------------------------
// Pestañas
// ---------------------------------------------------------------------------
function cambiarModo(modo) {
    modoActual = modo;
    const esBackup = modo === 'backup';

    tabBackup.classList.toggle('active', esBackup);
    tabRestore.classList.toggle('active', !esBackup);
    tabBackup.setAttribute('aria-selected', String(esBackup));
    tabRestore.setAttribute('aria-selected', String(!esBackup));
    vistaBackup.hidden = !esBackup;
    vistaRestore.hidden = esBackup;

    actualizarBoton();
    if (!esBackup) cargarListaRespaldos();
}

tabBackup.addEventListener('click', () => cambiarModo('backup'));
tabRestore.addEventListener('click', () => cambiarModo('restore'));

// ---------------------------------------------------------------------------
// Lista de respaldos
// ---------------------------------------------------------------------------
async function cargarListaRespaldos() {
    respaldoSeleccionado = ''; // evita restaurar una selección que ya no se ve
    const carpetaBase = backupPathInput.value;

    if (!carpetaBase) {
        listaRespaldos.replaceChildren(
            crearMensajeLista('Primero selecciona la Ubicación base en la tarjeta derecha.', 'error')
        );
        return;
    }

    listaRespaldos.replaceChildren(crearMensajeLista('Buscando respaldos...'));
    const respuesta = await ipcRenderer.invoke('get-backups-list', carpetaBase);

    if (!respuesta.success) {
        listaRespaldos.replaceChildren(crearMensajeLista(`No se pudo leer la carpeta: ${respuesta.msg}`, 'error'));
        return;
    }
    if (respuesta.respaldos.length === 0) {
        listaRespaldos.replaceChildren(crearMensajeLista('No se encontraron respaldos en esta ruta.'));
        return;
    }

    listaRespaldos.replaceChildren();
    respuesta.respaldos.forEach((nombreRespaldo) => {
        const item = document.createElement('div');
        item.className = 'backup-item';
        item.textContent = `📦 ${nombreRespaldo}`;

        item.addEventListener('click', () => {
            if (operacionEnCurso) return;
            listaRespaldos.querySelectorAll('.backup-item').forEach((el) => el.classList.remove('selected'));
            item.classList.add('selected');
            respaldoSeleccionado = nombreRespaldo;
        });

        listaRespaldos.appendChild(item);
    });
}

// ---------------------------------------------------------------------------
// Ejecución de operaciones
// ---------------------------------------------------------------------------
async function ejecutarOperacionUI({ tipo, canal, payload, estadoInicial, textoInicial }) {
    operacionEnCurso = tipo;
    cancelacionEnCurso = false;
    bloquearControles(true);
    actualizarBoton();

    setStatus(estadoInicial);
    progressContainer.classList.add('progress-visible');
    progresoTexto.innerText = '';
    progressBar.classList.remove('progress-error', 'progress-cancelled');
    setProgress(0, textoInicial, true);

    let respuesta;
    try {
        respuesta = await ipcRenderer.invoke(canal, payload);
    } catch (error) {
        respuesta = { success: false, msg: error.message };
    }

    operacionEnCurso = null;
    cancelacionEnCurso = false;
    bloquearControles(false);
    actualizarBoton();
    mostrarResultado(tipo, respuesta);
}

function mostrarResultado(tipo, respuesta) {
    const etiqueta = tipo === 'restore' ? 'Restauración' : 'Respaldo';
    const o = tipo === 'restore' ? 'a' : 'o'; // concordancia de género
    progresoTexto.innerText = '';

    if (respuesta.cancelled) {
        setStatus(`${etiqueta} cancelad${o}.`, 'info');
        progressBar.classList.add('progress-cancelled');
        setProgress(ultimoPorcentaje, `${etiqueta} cancelad${o} en ${Math.floor(ultimoPorcentaje)}%`);
    } else if (respuesta.success) {
        const advertencias = respuesta.warnings || [];
        if (advertencias.length) {
            setStatus(`${etiqueta} completad${o} con ${advertencias.length} advertencia(s).`, 'warning');
            progresoTexto.innerText = advertencias.join(' · ');
        } else {
            setStatus(`${etiqueta} completad${o}`, 'success');
        }
        setProgress(100, `100% completado · ${respuesta.msg}`);
    } else {
        setStatus(`Error: ${respuesta.msg}`, 'error');
        progressBar.classList.add('progress-error');
        setProgress(ultimoPorcentaje, `${etiqueta} no completad${o} (${Math.floor(ultimoPorcentaje)}%)`);
        const advertencias = respuesta.warnings || [];
        if (advertencias.length) progresoTexto.innerText = advertencias.join(' · ');
    }
}

async function cancelarOperacion() {
    if (cancelacionEnCurso) return;

    cancelacionEnCurso = true;
    actualizarBoton();
    setStatus('Cancelando. Espera a que ADB se detenga.');
    progressText.innerText = 'Cancelando...';

    try {
        const resultado = await ipcRenderer.invoke('cancel-operation');
        if (!resultado.success && operacionEnCurso) {
            cancelacionEnCurso = false;
            actualizarBoton();
            setStatus(resultado.msg, 'error');
        }
    } catch (error) {
        if (operacionEnCurso) {
            cancelacionEnCurso = false;
            actualizarBoton();
            setStatus(`No se pudo cancelar: ${error.message}`, 'error');
        }
    }
}

async function iniciarRespaldo() {
    if (!dispositivoIdActual) {
        setStatus('No se detectó el ID del dispositivo.', 'error');
        return;
    }

    const carpetaDestino = backupPathInput.value;
    if (!carpetaDestino) {
        setStatus('Selecciona la carpeta de destino.', 'error');
        return;
    }

    const selecciones = {
        whatsapp: document.getElementById('whatsapp-data').checked,
        telegram: document.getElementById('telegram-data').checked,
        dcim: document.getElementById('dcim-data').checked,
        downloads: document.getElementById('downloads-data').checked,
        extras: carpetasExtra,
        backupName: backupNameInput.value.trim() || generarNombreBackup(dispositivoIdActual),
        destinationPath: carpetaDestino
    };

    if (!selecciones.whatsapp && !selecciones.telegram && !selecciones.dcim &&
        !selecciones.downloads && !selecciones.extras.length) {
        setStatus('Selecciona al menos una opción para respaldar.', 'error');
        return;
    }

    await ejecutarOperacionUI({
        tipo: 'backup',
        canal: 'start-backup',
        payload: selecciones,
        estadoInicial: 'No desconectes el cable durante el respaldo.',
        textoInicial: 'Preparando respaldo...'
    });
}

async function iniciarRestauracion() {
    if (!dispositivoIdActual) {
        setStatus('No se detectó el ID del dispositivo.', 'error');
        return;
    }
    if (!respaldoSeleccionado) {
        setStatus('Selecciona un respaldo de la lista primero.', 'error');
        return;
    }

    const confirmado = window.confirm(
        `Se copiarán al teléfono los archivos de "${respaldoSeleccionado}".\n` +
        'Los archivos que ya existan con el mismo nombre serán sobrescritos.\n\n¿Continuar?'
    );
    if (!confirmado) return;

    await ejecutarOperacionUI({
        tipo: 'restore',
        canal: 'start-restore',
        payload: { rutaRespaldoPC: path.join(backupPathInput.value, respaldoSeleccionado) },
        estadoInicial: `Restaurando desde: ${respaldoSeleccionado}. No desconectes el cable.`,
        textoInicial: 'Preparando restauración...'
    });
}

btnBackup.addEventListener('click', async () => {
    if (operacionEnCurso) {
        await cancelarOperacion();
        return;
    }
    if (modoActual === 'restore') {
        await iniciarRestauracion();
    } else {
        await iniciarRespaldo();
    }
});

// ---------------------------------------------------------------------------
// Progreso enviado por el proceso principal
// ---------------------------------------------------------------------------
function textoTarea(u) {
    return `${u.taskName} (${u.taskIndex + 1} de ${u.taskCount})`;
}

ipcRenderer.on('backup-progress', (event, u) => {
    if (!operacionEnCurso || cancelacionEnCurso) return;

    const verbo = operacionEnCurso === 'restore' ? 'Restaurando' : 'Respaldando';

    switch (u.type) {
        case 'prepare':
            progresoTexto.innerText = u.text;
            setProgress(ultimoPorcentaje, 'Analizando contenido...', true);
            break;

        case 'task-start':
            progresoTexto.innerText = `${verbo}: ${u.taskName}`;
            setProgress(
                ultimoPorcentaje,
                `${Math.floor(ultimoPorcentaje)}% completado · ${textoTarea(u)}`,
                true
            );
            break;

        case 'progress':
            setProgress(u.percent, `${Math.floor(u.percent)}% completado · ${textoTarea(u)}`, true);
            if (u.file) progresoTexto.innerText = `${nombreArchivo(u.file)} (${u.filePercent}%)`;
            break;

        case 'task-complete':
            progresoTexto.innerText = `${u.taskName} completada`;
            break;

        case 'log':
            progresoTexto.innerText = u.text;
            break;
    }
});

// ---------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------
actualizarBoton();