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
const deleteBackupButton = document.getElementById('delete-backup-btn');
const confirmModal = document.getElementById('confirm-modal');
const confirmModalTitle = document.getElementById('confirm-modal-title');
const confirmModalMessage = document.getElementById('confirm-modal-message');
const confirmModalCancel = document.getElementById('confirm-modal-cancel');
const confirmModalAccept = document.getElementById('confirm-modal-accept');

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
let nombreBackupDraft = '';
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

function formatearDuracion(milisegundos) {
    const totalSegundos = Math.floor(milisegundos / 1000);
    const minutos = Math.floor(totalSegundos / 60);
    const segundos = totalSegundos % 60;
    return minutos > 0
        ? `${minutos} min ${segundos} s`
        : `${segundos} s`;
}

function formatearGigabytes(bytes) {
    const gigabytes = bytes / (1024 ** 3);
    return `${gigabytes < 0.01 && gigabytes > 0 ? '<0.01' : gigabytes.toFixed(2)} GB`;
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
    document.body.classList.toggle('is-backing-up', bloquear && operacionEnCurso === 'backup');
    document.body.classList.toggle('is-restoring', bloquear && operacionEnCurso === 'restore');

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

let resolverConfirmacion = null;
let elementoPrevioAlModal = null;

function cerrarModalConfirmacion(confirmado) {
    if (!resolverConfirmacion) return;
    const resolver = resolverConfirmacion;
    resolverConfirmacion = null;
    confirmModal.hidden = true;
    if (elementoPrevioAlModal?.isConnected) elementoPrevioAlModal.focus();
    elementoPrevioAlModal = null;
    resolver(confirmado);
}

function mostrarModalConfirmacion({ titulo, mensaje, textoAceptar, peligro = false }) {
    if (resolverConfirmacion) return Promise.resolve(false);

    elementoPrevioAlModal = document.activeElement;
    confirmModalTitle.textContent = titulo;
    confirmModalMessage.textContent = mensaje;
    confirmModalAccept.textContent = textoAceptar;
    confirmModalAccept.classList.toggle('danger-action', peligro);
    confirmModal.hidden = false;

    return new Promise((resolve) => {
        resolverConfirmacion = resolve;
        confirmModalCancel.focus();
    });
}

confirmModalCancel.addEventListener('click', () => cerrarModalConfirmacion(false));
confirmModalAccept.addEventListener('click', () => cerrarModalConfirmacion(true));
confirmModal.addEventListener('click', (event) => {
    if (event.target === confirmModal) cerrarModalConfirmacion(false);
});
document.addEventListener('keydown', (event) => {
    if (confirmModal.hidden) return;
    if (event.key === 'Escape') {
        cerrarModalConfirmacion(false);
    } else if (event.key === 'Tab') {
        const botones = [confirmModalCancel, confirmModalAccept];
        const indiceActual = botones.indexOf(document.activeElement);
        if (event.shiftKey && indiceActual <= 0) {
            event.preventDefault();
            confirmModalAccept.focus();
        } else if (!event.shiftKey && indiceActual === botones.length - 1) {
            event.preventDefault();
            confirmModalCancel.focus();
        }
    }
});

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

        const icono = document.createElement('span');
        icono.className = 'folder-badge-icon';
        icono.setAttribute('aria-hidden', 'true');

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('focusable', 'false');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M3 6.5A1.5 1.5 0 0 1 4.5 5H10l2 2h7.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5v-11Z');
        svg.appendChild(path);
        icono.appendChild(svg);

        const etiqueta = document.createElement('span');
        etiqueta.textContent = carpeta.nombre;

        const quitar = document.createElement('button');
        quitar.type = 'button';
        quitar.className = 'quitar';
        quitar.title = 'Quitar';
        quitar.setAttribute('aria-label', `Quitar carpeta ${carpeta.nombre}`);
        const quitarSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        quitarSvg.setAttribute('viewBox', '0 0 24 24');
        quitarSvg.setAttribute('focusable', 'false');
        quitarSvg.setAttribute('aria-hidden', 'true');
        const quitarPath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        quitarPath.setAttribute('d', 'm6 6 12 12M18 6 6 18');
        quitarSvg.appendChild(quitarPath);
        quitar.appendChild(quitarSvg);
        quitar.addEventListener('click', () => {
            if (operacionEnCurso) return;
            carpetasExtra = carpetasExtra.filter((c) => c.ruta !== carpeta.ruta);
            renderizarCarpetas();
        });

        badge.append(icono, etiqueta, quitar);
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
        deviceStatus.innerText = `Conectado: ${data.nombre || data.id}`;
        deviceStatus.classList.add('success');

        if (!operacionEnCurso) setStatus('Dispositivo detectado. Listo para operar.', 'success');
        cargarCarpetasAndroid();
    } else {
        dispositivoIdActual = '';
        phoneCard.classList.remove('device-connected');
        deviceStatus.innerText = 'Buscando dispositivo...';
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
    const esBackup = modo === 'backup';

    if (esBackup && modoActual !== 'backup') {
        backupNameInput.disabled = false;
        backupNameInput.value = nombreBackupDraft;
    } else if (!esBackup && modoActual !== 'restore') {
        nombreBackupDraft = backupNameInput.value;
        backupNameInput.value = '';
        backupNameInput.disabled = true;
    }

    modoActual = modo;
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
    backupNameInput.value = '';
    deleteBackupButton.disabled = true;
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

        const icono = document.createElement('span');
        icono.className = 'backup-item-icon';
        icono.setAttribute('aria-hidden', 'true');

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('focusable', 'false');
        [
            'M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Z',
            'm3 7.5 9 4.5 9-4.5',
            'M12 12v9',
            'm7.5 5.25 9 4.5'
        ].forEach((d) => {
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', d);
            svg.appendChild(path);
        });

        icono.appendChild(svg);
        item.append(icono, document.createTextNode(nombreRespaldo));

        item.addEventListener('click', () => {
            if (operacionEnCurso) return;
            listaRespaldos.querySelectorAll('.backup-item').forEach((el) => el.classList.remove('selected'));
            item.classList.add('selected');
            respaldoSeleccionado = nombreRespaldo;
            backupNameInput.value = nombreRespaldo;
            deleteBackupButton.disabled = false;
        });

        listaRespaldos.appendChild(item);
    });
}

deleteBackupButton.addEventListener('click', async () => {
    if (operacionEnCurso || !respaldoSeleccionado) return;

    const nombreRespaldo = respaldoSeleccionado;
    const confirmado = await mostrarModalConfirmacion({
        titulo: 'Eliminar respaldo',
        mensaje: `¿Eliminar "${nombreRespaldo}" permanentemente? Esta acción no se puede deshacer.`,
        textoAceptar: 'Eliminar',
        peligro: true
    });
    if (!confirmado) return;

    deleteBackupButton.disabled = true;
    try {
        const respuesta = await ipcRenderer.invoke('delete-backup', {
            carpetaBase: backupPathInput.value,
            nombreRespaldo
        });
        if (!respuesta.success) {
            setStatus(respuesta.msg, 'error');
            deleteBackupButton.disabled = false;
            return;
        }

        setStatus('Respaldo eliminado.', 'success');
        await cargarListaRespaldos();
    } catch (error) {
        setStatus(`No se pudo eliminar el respaldo: ${error.message}`, 'error');
        deleteBackupButton.disabled = false;
    }
});

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
    const inicio = performance.now();
    try {
        respuesta = await ipcRenderer.invoke(canal, payload);
    } catch (error) {
        respuesta = { success: false, msg: error.message };
    }
    const duracionMs = performance.now() - inicio;

    operacionEnCurso = null;
    cancelacionEnCurso = false;
    bloquearControles(false);
    actualizarBoton();
    mostrarResultado(tipo, respuesta, duracionMs);
}

function mostrarResultado(tipo, respuesta, duracionMs) {
    const etiqueta = tipo === 'restore' ? 'Restauración' : 'Respaldo';
    const o = tipo === 'restore' ? 'a' : 'o'; // concordancia de género
    progresoTexto.innerText = '';

    if (respuesta.cancelled) {
        setStatus(`${etiqueta} cancelad${o}.`, 'info');
        progressBar.classList.add('progress-cancelled');
        setProgress(ultimoPorcentaje, `${etiqueta} cancelad${o} en ${Math.floor(ultimoPorcentaje)}%`);
    } else if (respuesta.success) {
        const advertencias = respuesta.warnings || [];
        const bytesTransferidos = tipo === 'backup'
            ? respuesta.bytesRespaldados
            : respuesta.bytesRestaurados;
        const detalleOperacion = Number.isFinite(bytesTransferidos)
            ? ` · ${formatearGigabytes(bytesTransferidos)} · ${formatearDuracion(duracionMs)}`
            : '';
        if (advertencias.length) {
            setStatus(`${etiqueta} completad${o} con ${advertencias.length} advertencia(s)${detalleOperacion}.`, 'warning');
            progresoTexto.innerText = advertencias.join(' · ');
        } else {
            setStatus(`${etiqueta} completad${o}${detalleOperacion}`, 'success');
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
        destinationPath: carpetaDestino
    };

    if (!selecciones.whatsapp && !selecciones.telegram && !selecciones.dcim &&
        !selecciones.downloads && !selecciones.extras.length) {
        setStatus('Selecciona al menos una opción para respaldar.', 'error');
        return;
    }

    const nombreBackup = backupNameInput.value.trim() || generarNombreBackup(dispositivoIdActual);
    backupNameInput.value = nombreBackup;
    selecciones.backupName = nombreBackup;

    let actualizarExistente = false;
    try {
        const comprobacion = await ipcRenderer.invoke('check-backup-target', {
            carpetaBase: carpetaDestino,
            nombreBackup
        });
        if (!comprobacion.success) {
            setStatus(comprobacion.msg, 'error');
            return;
        }

        if (comprobacion.exists) {
            actualizarExistente = await mostrarModalConfirmacion({
                titulo: '¿Actualizar respaldo existente?',
                mensaje: `Ya existe un respaldo llamado "${nombreBackup}". Si decides continuar:
                    \n - Los archivos modificados reemplazarán a sus versiones antiguas.
                    \n - El resto de los archivos originales se conservarán intactos.
                    \n¿Deseas fusionar los datos?`,
                textoAceptar: 'Fusionar y Actualizar'
            });
            if (!actualizarExistente) return;
        }
    } catch (error) {
        setStatus(`No se pudo comprobar si el respaldo ya existe: ${error.message}`, 'error');
        return;
    }

    selecciones.actualizarExistente = actualizarExistente;

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

    const confirmado = await mostrarModalConfirmacion({
        titulo: 'Restauración inteligente',
        mensaje: `Vamos a restaurar "${respaldoSeleccionado}" en tu dispositivo.\nPara ahorrar tiempo, tus fotos y descargas se sincronizarán (solo se enviará lo que falte). Sin embargo, carpetas críticas como WhatsApp sobrescribirán tu estado actual para regresar exactamente a la fecha del respaldo.\n¿Deseas iniciar?`,
        textoAceptar: 'iniciar restauración'
    });
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
            setProgress(Number(u.percent), `${Number(u.percent).toFixed(1)}% completado · ${textoTarea(u)}`, true);
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