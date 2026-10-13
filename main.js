const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs/promises');
const { createWriteStream, createReadStream } = require('fs');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');
const path = require('path');
const https = require('https');
const adbPath = path.join(__dirname, 'bin', 'adb.exe');

const WHATSAPP_PACKAGE = 'com.whatsapp';
const WHATSAPP_APK_URL = 'https://github.com/MrEarv/das-hopper/releases/download/v1.0.0-asset/whatsapp.apk';
const WHATSAPP_APK_SHA256 = '';

// ---------------------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------------------
let dispositivoActual = null;
const operacionesActivas = new Map();

const RESULTADO_CANCELADO = () => ({
    success: false,
    cancelled: true,
    msg: 'Operación cancelada por el usuario.'
});

// ---------------------------------------------------------------------------
// Ventana
// ---------------------------------------------------------------------------
function createWindow() {
    const win = new BrowserWindow({
        width: 1000,
        height: 700,
       // backgroundColor: '#1e1e1e',
        show: false,
        icon: path.join(__dirname, 'assets', 'icon.png'),
        webPreferences: {
           // sandbox: true,
            nodeIntegration: false, // <-- BLOQUEADO: El HTML ya no tiene acceso a Node
            contextIsolation: true, // <-- ACTIVADO: Separación estricta de contextos
            preload: path.join(__dirname, 'preload.js') // <-- Inyectamos la aduana
        },
        frame: true,
        autoHideMenuBar: true,
        center: true
    });

    win.once('ready-to-show', () => win.show());
    win.loadFile('index.html');
    iniciarMonitorADB(win);
}
app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
    for (const op of operacionesActivas.values()) cancelarOperacionActiva(op);
});

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
const shQuote = (texto) => `'${String(texto).replace(/'/g, `'\\''`)}'`;

const ultimasLineas = (texto, n = 3) =>
    String(texto)
        .split(/[\r\n]+/)
        .map((l) => l.trim())
        .filter((l) => l && !/^\[\s*\d+%\]/.test(l))
        .slice(-n)
        .join(' | ');

function formatearBytes(bytes) {
    const unidades = ['B', 'KB', 'MB', 'GB', 'TB'];
    let valor = bytes;
    let i = 0;
    while (valor >= 1024 && i < unidades.length - 1) {
        valor /= 1024;
        i++;
    }
    return `${valor.toFixed(i === 0 ? 0 : 1)} ${unidades[i]}`;
}

const porcentaje = (hecho, total) => (total > 0 ? Math.max(0, Math.min(100, (hecho / total) * 100)) : 0);
const claveRutaLocal = (ruta) => path.resolve(ruta).toLowerCase();

function nombreBackupValido(nombreBackup) {
    return Boolean(
        nombreBackup &&
        nombreBackup.length <= 100 &&
        !/[<>:"/\\|?*\x00-\x1f]/.test(nombreBackup) &&
        !/[. ]$/.test(nombreBackup) &&
        !/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(nombreBackup)
    );
}

function cancelarOperacionActiva(op) {
    op.cancelado = true;
    try { if (op.proceso && !op.proceso.killed) op.proceso.kill(); } catch (e) { /* ignorar */ }
    try { if (op.request) op.request.destroy(); } catch (e) { /* ignorar */ }
}

/** Ejecuta un comando ADB y devuelve { ok, stdout, stderr }. Nunca lanza. */
function ejecutarAdb(serial, args, { timeout = 30000, op = null } = {}) {
    return new Promise((resolve) => {
        const argv = serial ? ['-s', serial, ...args] : args;
        const child = execFile(
            adbPath,
            argv,
            { timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
            (error, stdout, stderr) => {
                if (op && op.proceso === child) op.proceso = null;
                resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '', error });
            }
        );
        if (op) op.proceso = child;
    });
}

function parsearDispositivos(stdout) {
    return stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && !l.startsWith('*') && !/^List of devices/i.test(l))
        .map((l) => {
            const [id, estado] = l.split(/\s+/);
            return { id, estado };
        })
        .filter((d) => d.id && d.estado);
}

function elegirDispositivo(lista) {
    const listo = lista.find((d) => d.estado === 'device');
    if (listo) return { id: listo.id, estado: 'device' };
    if (lista.length > 0) return { id: null, estado: lista[0].estado };
    return { id: null, estado: 'none' };
}

async function obtenerNombreDispositivo(serial) {
    const resultado = await ejecutarAdb(
        serial,
        ['shell', 'getprop ro.product.marketname; getprop ro.product.manufacturer; getprop ro.product.model'],
        { timeout: 8000 }
    );
    if (!resultado.ok) return serial;

    const [nombreComercial, fabricante, modelo] = resultado.stdout
        .split(/\r?\n/)
        .map((valor) => valor.trim());
    return nombreComercial || [fabricante, modelo].filter(Boolean).join(' ') || serial;
}

function crearEmisor(event) {
    let ultimoEnvio = 0;
    let maxPorcentaje = 0;
    let maxBytes = 0;
    const enviar = (payload) => {
        if (payload.type === 'progress') {
            payload.percent = Math.max(maxPorcentaje, payload.percent);
            maxPorcentaje = payload.percent;
            if (Number.isFinite(payload.bytesDone)) {
                payload.bytesDone = Math.max(maxBytes, payload.bytesDone);
                maxBytes = payload.bytesDone;
            }
        }
        if (!event.sender.isDestroyed()) event.sender.send('backup-progress', payload);
    };
    return {
        enviar,
        progreso(payload) {
            const ahora = Date.now();
            if (ahora - ultimoEnvio < 80 && payload.percent < 100) return;
            ultimoEnvio = ahora;
            enviar({ type: 'progress', ...payload });
        }
    };
}

async function esDirectorio(ruta) {
    try {
        return (await fs.stat(ruta)).isDirectory();
    } catch (e) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Monitor de dispositivo
// ---------------------------------------------------------------------------
function iniciarMonitorADB(win) {
    let consultando = false;
    let ultimaClave = null;

    const consultar = async () => {
        if (consultando || win.isDestroyed()) return;
        consultando = true;
        try {
            const r = await ejecutarAdb(null, ['devices'], { timeout: 8000 });
            const sel = r.ok
                ? elegirDispositivo(parsearDispositivos(r.stdout))
                : { id: null, estado: 'adb-error' };

            dispositivoActual = sel.id;

            const clave = `${sel.id}|${sel.estado}`;
            if (clave !== ultimaClave && !win.isDestroyed()) {
                ultimaClave = clave;
                const nombre = sel.id ? await obtenerNombreDispositivo(sel.id) : null;
                if (win.isDestroyed()) return;
                win.webContents.send(
                    'estado-dispositivo',
                    sel.id
                        ? { conectado: true, id: sel.id, nombre }
                        : { conectado: false, estado: sel.estado }
                );
            }
        } finally {
            consultando = false;
        }
    };

    const timer = setInterval(consultar, 2000);
    win.on('closed', () => clearInterval(timer));
    win.webContents.once('did-finish-load', consultar);
}

// ---------------------------------------------------------------------------
// IPC simples
// ---------------------------------------------------------------------------
ipcMain.handle('select-backup-folder', async (event) => {
    const ventana = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(ventana, {
        properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('get-backups-list', async (event, carpetaBase) => {
    try {
        if (typeof carpetaBase !== 'string' || !carpetaBase) {
            return { success: false, msg: 'Ruta no válida.' };
        }
        const elementos = await fs.readdir(carpetaBase, { withFileTypes: true });
        const carpetas = [];
        for (const dirent of elementos) {
            if (!dirent.isDirectory()) continue;
            let mtime = 0;
            try { mtime = (await fs.stat(path.join(carpetaBase, dirent.name))).mtimeMs; } catch (e) { /* ignorar */ }
            carpetas.push({ nombre: dirent.name, mtime });
        }
        carpetas.sort((a, b) => b.mtime - a.mtime); // más recientes primero
        return { success: true, respaldos: carpetas.map((c) => c.nombre) };
    } catch (error) {
        return { success: false, msg: error.message };
    }
});

ipcMain.handle('check-backup-target', async (event, datos) => {
    const carpetaBase = typeof datos?.carpetaBase === 'string' ? datos.carpetaBase.trim() : '';
    const nombreBackup = typeof datos?.nombreBackup === 'string' ? datos.nombreBackup.trim() : '';
    if (!carpetaBase || !path.isAbsolute(carpetaBase) || !nombreBackupValido(nombreBackup)) {
        return { success: false, msg: 'La ubicación o el nombre del respaldo no son válidos.' };
    }

    try {
        const info = await fs.lstat(path.join(carpetaBase, nombreBackup));
        if (!info.isDirectory() || info.isSymbolicLink()) {
            return { success: false, msg: 'Ya existe un elemento con ese nombre que no es una carpeta de respaldo.' };
        }
        return { success: true, exists: true };
    } catch (error) {
        if (error.code === 'ENOENT') return { success: true, exists: false };
        return { success: false, msg: `No se pudo comprobar el respaldo existente: ${error.message}` };
    }
});

ipcMain.handle('delete-backup', async (event, datos) => {
    try {
        const carpetaBase = typeof datos?.carpetaBase === 'string' ? datos.carpetaBase : '';
        const nombreRespaldo = typeof datos?.nombreRespaldo === 'string' ? datos.nombreRespaldo : '';
        if (!carpetaBase || !path.isAbsolute(carpetaBase) ||
            !nombreRespaldo || path.basename(nombreRespaldo) !== nombreRespaldo ||
            nombreRespaldo === '.' || nombreRespaldo === '..') {
            return { success: false, msg: 'La ruta del respaldo no es válida.' };
        }

        const baseResuelta = path.resolve(carpetaBase);
        const respaldoResuelto = path.resolve(baseResuelta, nombreRespaldo);
        if (path.dirname(respaldoResuelto) !== baseResuelta) {
            return { success: false, msg: 'El respaldo debe estar directamente dentro de la ubicación seleccionada.' };
        }

        const info = await fs.lstat(respaldoResuelto);
        if (!info.isDirectory() || info.isSymbolicLink()) {
            return { success: false, msg: 'El elemento seleccionado no es una carpeta de respaldo válida.' };
        }

        await fs.rm(respaldoResuelto, { recursive: true });
        return { success: true };
    } catch (error) {
        return { success: false, msg: `No se pudo eliminar el respaldo: ${error.message}` };
    }
});

ipcMain.handle('check-devices', async () => {
    const r = await ejecutarAdb(null, ['devices'], { timeout: 8000 });
    if (!r.ok) return { success: false, msg: 'ADB no ejecutado', error: r.error && r.error.message };
    const sel = elegirDispositivo(parsearDispositivos(r.stdout));
    return sel.id ? { success: true, id: sel.id } : { success: false, msg: 'Ningún dispositivo listo detectado' };
});

ipcMain.handle('get-android-folders', async () => {
    if (!dispositivoActual) return { success: false, carpetas: [] };
    const r = await ejecutarAdb(dispositivoActual, ['shell', 'ls', '-p', '/sdcard/']);
    if (!r.ok) return { success: false, carpetas: [] };

    const carpetas = r.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l.endsWith('/') && !l.startsWith('.'))
        .map((l) => l.slice(0, -1))
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));

    return { success: true, carpetas };
});

// ---------------------------------------------------------------------------
// Control de operaciones (respaldo / restauración)
// ---------------------------------------------------------------------------
async function ejecutarOperacion(event, tipo, fn) {
    const senderId = event.sender.id;
    if (operacionesActivas.has(senderId)) {
        return { success: false, msg: 'Ya hay una operación en curso.' };
    }

    const op = { tipo, cancelado: false, proceso: null, request: null };
    operacionesActivas.set(senderId, op);
    try {
        return await fn(op);
    } catch (error) {
        return op.cancelado ? RESULTADO_CANCELADO() : { success: false, msg: error.message };
    } finally {
        operacionesActivas.delete(senderId);
    }
}

ipcMain.handle('start-backup', (event, selecciones) =>
    ejecutarOperacion(event, 'backup', (op) => ejecutarRespaldo(event, selecciones || {}, op))
);

ipcMain.handle('start-restore', (event, datos) =>
    ejecutarOperacion(event, 'restore', (op) => ejecutarRestauracion(event, datos || {}, op))
);

ipcMain.handle('cancel-operation', (event) => {
    const op = operacionesActivas.get(event.sender.id);
    if (!op) {
        return { success: false, msg: 'No hay ninguna operación en curso para cancelar.' };
    }
    cancelarOperacionActiva(op);
    return { success: true, msg: 'Se solicitó cancelar la operación.' };
});

// ---------------------------------------------------------------------------
// Transferencia ADB (pull / push) con lectura de progreso
// ---------------------------------------------------------------------------
function transferirADB(serial, accion, origen, destino, op, { onArchivo, onTexto, usarSync = false, argsAdb = null } = {}) {
    return new Promise((resolve, reject) => {
        const args = argsAdb
            ? ['-s', serial, ...argsAdb]
            : accion === 'pull'
                ? ['-s', serial, 'pull', '-a', origen, destino]
                : usarSync
                    ? ['-s', serial, 'push', '--sync', origen, destino]
                    : ['-s', serial, 'push', origen, destino];

        const proc = spawn(adbPath, args, { windowsHide: true });
        op.proceso = proc;

        let pendiente = '';
        let cola = '';

        const procesarLinea = (linea) => {
            const l = linea.trim();
            if (!l) return;
            const m = l.match(/^\[\s*(\d{1,3})%\]\s+(.+)$/);
            if (m) {
                if (onArchivo) onArchivo({ pct: Math.min(100, Number(m[1])), archivo: m[2] });
            } else if (onTexto) {
                onTexto(l);
            }
        };

        const manejarSalida = (data) => {
            const texto = data.toString();
            cola = (cola + texto).slice(-4000);
            pendiente += texto;
            const partes = pendiente.split(/[\r\n]+/);
            pendiente = partes.pop();
            partes.forEach(procesarLinea);
        };

        proc.stdout.on('data', manejarSalida);
        proc.stderr.on('data', manejarSalida);

        proc.once('error', (error) => {
            if (op.proceso === proc) op.proceso = null;
            reject(error);
        });

        proc.once('close', (code) => {
            if (op.proceso === proc) op.proceso = null;
            if (pendiente.trim()) procesarLinea(pendiente);

            if (op.cancelado) return resolve({ cancelado: true });
            if (code === 0) return resolve({ parcial: false });

            const fatal = /no devices|device offline|not found|unauthorized|closed|more than one|no space/i.test(cola);
            const hayResumen = /\d+ files? (pulled|pushed)/i.test(cola);
            if (!fatal && hayResumen) {
                // adb copió la mayoría pero algunos archivos fallaron
                return resolve({ parcial: true, detalle: ultimasLineas(cola) });
            }
            const error = new Error(ultimasLineas(cola) || `ADB terminó con código ${code}`);
            error.fatal = fatal;
            reject(error);
        });
    });
}

// ---------------------------------------------------------------------------
// ADB no informa progreso fiable: se mide lo escrito en pull y se estima push por lotes.
// ---------------------------------------------------------------------------
const UNIDAD_MAX_BYTES = 128 * 1024 * 1024;
const UNIDAD_MAX_ARCHIVOS = 400;
const LOTE_MAX_CHARS = 12000;

function emitirProgreso(emisor, { baseKB, totalKB, hechoKB, info, extra = {}, forzar = false }) {
    const total = Math.max(1, totalKB);
    const hecho = Math.max(0, Math.min(total, baseKB + hechoKB));
    const payload = {
        percent: porcentaje(hecho, total),
        bytesDone: hecho * 1024,
        bytesTotal: total * 1024,
        ...info,
        ...extra
    };
    if (forzar) emisor.enviar({ type: 'progress', ...payload });
    else emisor.progreso(payload);
}

function crearEstimador(velocidadInicial = 12 * 1024 * 1024) {
    let velocidad = velocidadInicial;
    return {
        velocidad: () => velocidad,
        registrar(bytes, ms) {
            if (bytes < 4 * 1024 * 1024 || ms < 1200) return;
            velocidad = velocidad * 0.6 + (bytes / (ms / 1000)) * 0.4;
        }
    };
}

// En respaldos existentes, solo cuenta los archivos que ADB modifica durante la copia.
function crearMonitorCarpeta(raiz, onCambio, { intervaloMs = 500 } = {}) {
    const desdeMs = Date.now() - 1000;
    const existentes = new Set();
    const tocados = new Map();
    let activos = new Set();
    let ultimo = null;
    let bytes = 0;
    let corriendo = false;
    let ciclo = null;
    let temporizador = null;
    let despertar = null;

    async function pasada() {
        const aRevisar = new Set([...activos]);
        if (ultimo) aRevisar.add(ultimo);

        const pila = [raiz];
        while (pila.length) {
            const dir = pila.pop();
            let entradas;
            try {
                entradas = await fs.readdir(dir, { withFileTypes: true });
            } catch (e) {
                continue;
            }
            for (const e of entradas) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) pila.push(p);
                else if (e.isFile() && !tocados.has(p)) aRevisar.add(p);
            }
        }

        const cambiados = new Set();
        let mtimeUltimo = -1;
        for (const p of aRevisar) {
            let st;
            try {
                st = await fs.stat(p);
            } catch (e) {
                continue;
            }
            if (existentes.has(p) && st.ctimeMs < desdeMs) continue;
            const previo = tocados.get(p);
            if (previo === undefined || st.size !== previo) {
                bytes += st.size - (previo || 0);
                tocados.set(p, st.size);
                cambiados.add(p);
                if (st.mtimeMs >= mtimeUltimo) {
                    mtimeUltimo = st.mtimeMs;
                    ultimo = p;
                }
            }
        }
        activos = cambiados;
    }

    function esperar(ms) {
        return new Promise((resolve) => {
            despertar = resolve;
            temporizador = setTimeout(resolve, ms);
        });
    }

    async function bucle() {
        while (corriendo) {
            const inicio = Date.now();
            await pasada();
            onCambio({ bytes: Math.max(0, bytes), archivos: tocados.size, archivo: ultimo });
            await esperar(Math.max(intervaloMs, Date.now() - inicio));
        }
    }

    async function listarExistentes() {
        const pila = [raiz];
        while (pila.length) {
            const dir = pila.pop();
            let entradas;
            try {
                entradas = await fs.readdir(dir, { withFileTypes: true });
            } catch (e) {
                continue;
            }
            for (const e of entradas) {
                const p = path.join(dir, e.name);
                if (e.isDirectory()) pila.push(p);
                else if (e.isFile()) existentes.add(p);
            }
        }
    }

    return {
        async iniciar() {
            await listarExistentes();
            corriendo = true;
            ciclo = bucle();
        },
        async detener() {
            corriendo = false;
            clearTimeout(temporizador);
            if (despertar) despertar();
            if (ciclo) await ciclo;
            await pasada();
            return { bytes: Math.max(0, bytes), archivos: tocados.size };
        }
    };
}

async function copiarConMonitor({ serial, origen, destino, tarea, baseKB, totalKB, info, op, emisor }) {
    const raiz = path.join(destino, path.posix.basename(origen.replace(/\/+$/, '')));
    const monitor = crearMonitorCarpeta(raiz, (m) => {
        emitirProgreso(emisor, {
            baseKB,
            totalKB,
            hechoKB: Math.min(m.bytes / 1024, tarea.pesoKB),
            info,
            extra: { file: m.archivo, filesDone: m.archivos, filesTotal: tarea.totalArchivos }
        });
    });

    await monitor.iniciar();
    try {
        return await transferirADB(serial, 'pull', origen, destino, op);
    } finally {
        await monitor.detener();
    }
}

// ---- Restauración por lotes ----

async function construirArbol(dir, op) {
    const nodo = { ruta: dir, nombre: path.basename(dir), archivos: [], subdirs: [], bytes: 0, totalArchivos: 0 };
    let entradas;
    try {
        entradas = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
        return nodo;
    }
    for (const e of entradas) {
        if (op.cancelado) break;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
            const hijo = await construirArbol(p, op);
            nodo.subdirs.push(hijo);
            nodo.bytes += hijo.bytes;
            nodo.totalArchivos += hijo.totalArchivos;
        } else if (e.isFile()) {
            try {
                const st = await fs.stat(p);
                nodo.archivos.push({ ruta: p, size: st.size });
                nodo.bytes += st.size;
                nodo.totalArchivos++;
            } catch (err) { /* ignorar */ }
        }
    }
    return nodo;
}

function armarLotes(archivos, remotoDir, relativo, plan) {
    const ordenados = [...archivos].sort((a, b) => a.ruta.localeCompare(b.ruta));
    let lote = [];
    let bytes = 0;
    let chars = 0;

    const cerrar = () => {
        if (!lote.length) return;
        plan.unidades.push({
            tipo: 'archivos',
            locales: lote.map((f) => f.ruta),
            remotoDir,
            bytes,
            archivos: lote.length,
            etiqueta: lote.length === 1 ? `${relativo}/${path.basename(lote[0].ruta)}` : `${relativo} (${lote.length} archivos)`
        });
        lote = [];
        bytes = 0;
        chars = 0;
    };

    for (const f of ordenados) {
        const largo = f.ruta.length + 3;
        if (lote.length && (lote.length >= UNIDAD_MAX_ARCHIVOS || bytes + f.size > UNIDAD_MAX_BYTES || chars + largo > LOTE_MAX_CHARS)) {
            cerrar();
        }
        lote.push(f);
        bytes += f.size;
        chars += largo;
    }
    cerrar();
}

function particionar(nodo, remotoDir, relativo, plan) {
    if (nodo.totalArchivos === 0) {
        plan.dirsRemotos.add(remotoDir);
        return;
    }
    if (nodo.totalArchivos <= UNIDAD_MAX_ARCHIVOS && nodo.bytes <= UNIDAD_MAX_BYTES) {
        const remotoPadre = path.posix.dirname(remotoDir);
        plan.unidades.push({
            tipo: 'dir',
            local: nodo.ruta,
            remotoPadre,
            bytes: nodo.bytes,
            archivos: nodo.totalArchivos,
            etiqueta: relativo
        });
        plan.dirsRemotos.add(remotoPadre);
        return;
    }

    plan.dirsRemotos.add(remotoDir);
    armarLotes(nodo.archivos, remotoDir, relativo, plan);
    for (const sub of nodo.subdirs) {
        particionar(sub, `${remotoDir}/${sub.nombre}`, `${relativo}/${sub.nombre}`, plan);
    }
}

function planificarTarea(arbol, nombreCarpeta) {
    const plan = { unidades: [], dirsRemotos: new Set() };
    particionar(arbol, `/sdcard/${nombreCarpeta}`, nombreCarpeta, plan);
    return plan;
}

function argumentosPush(unidad, usarSync) {
    const args = ['push'];
    if (usarSync) args.push('--sync');
    if (unidad.tipo === 'dir') return [...args, unidad.local, `${unidad.remotoPadre}/`];
    return [...args, ...unidad.locales, `${unidad.remotoDir}/`];
}

async function crearDirectoriosRemotos(serial, dirs, op) {
    const pendientes = dirs.filter((d) => d && d !== '/sdcard');
    while (pendientes.length) {
        if (op.cancelado) return;
        const grupo = [];
        let chars = 0;
        while (pendientes.length && grupo.length < 40 && chars < 6000) {
            const d = pendientes.shift();
            grupo.push(d);
            chars += d.length + 3;
        }
        const r = await ejecutarAdb(serial, ['shell', `mkdir -p ${grupo.map(shQuote).join(' ')}`], { op });
        if (!r.ok && !op.cancelado) {
            throw new Error(`No se pudieron crear carpetas en el teléfono: ${ultimasLineas(r.stderr || r.stdout)}`);
        }
    }
}

async function empujarPorLotes({ serial, tarea, usarSync, baseKB, totalKB, info, op, emisor, estimador, advertencias }) {
    await crearDirectoriosRemotos(serial, [...tarea.plan.dirsRemotos], op);
    if (op.cancelado) return { cancelado: true };

    let hechoBytes = 0;
    let fallos = 0;
    let huboParcial = false;

    for (const unidad of tarea.plan.unidades) {
        if (op.cancelado) return { cancelado: true };

        const inicio = Date.now();
        const base = hechoBytes;

        const animacion = setInterval(() => {
            const segundos = (Date.now() - inicio) / 1000;
            const estimado = Math.min(unidad.bytes * 0.92, segundos * estimador.velocidad());
            emitirProgreso(emisor, {
                baseKB,
                totalKB,
                hechoKB: Math.min(tarea.pesoKB, (base + estimado) / 1024),
                info,
                extra: { file: unidad.etiqueta }
            });
        }, 250);

        let r;
        try {
            r = await transferirADB(serial, 'push', null, null, op, { argsAdb: argumentosPush(unidad, usarSync) });
        } catch (error) {
            if (error.fatal || op.cancelado) throw error;
            fallos++;
            advertencias.push(`No se pudo copiar ${unidad.etiqueta}: ${error.message}`);
            if (fallos > 10) throw new Error('Demasiados errores al copiar al teléfono; se detuvo la restauración.');
            r = { parcial: false, fallo: true };
        } finally {
            clearInterval(animacion);
        }

        if (r.cancelado) return r;
        if (r.parcial) huboParcial = true;
        if (!r.fallo) estimador.registrar(unidad.bytes, Date.now() - inicio);

        hechoBytes += unidad.bytes;
        emitirProgreso(emisor, {
            baseKB,
            totalKB,
            hechoKB: Math.min(tarea.pesoKB, hechoBytes / 1024),
            info,
            extra: { file: unidad.etiqueta },
            forzar: true
        });
    }

    return { parcial: huboParcial };
}

async function transferirConProgreso({ serial, accion, origen, destino, tarea, indice, total, baseKB, totalKB, op, emisor, usarSync, estimador, advertencias }) {
    const info = { taskName: tarea.nombre, taskIndex: indice, taskCount: total };
    emisor.enviar({ type: 'task-start', ...info });
    emisor.enviar({ type: 'progress', percent: porcentaje(baseKB, totalKB), bytesDone: baseKB * 1024, bytesTotal: totalKB * 1024, ...info });

    const resultado = accion === 'pull'
        ? await copiarConMonitor({ serial, origen, destino, tarea, baseKB, totalKB, info, op, emisor })
        : await empujarPorLotes({ serial, tarea, usarSync, baseKB, totalKB, info, op, emisor, estimador, advertencias });

    if (resultado.cancelado) return resultado;

    emitirProgreso(emisor, { baseKB, totalKB, hechoKB: tarea.pesoKB, info, forzar: true });
    emisor.enviar({ type: 'task-complete', ...info });
    return resultado;
}

// ---------------------------------------------------------------------------
// RESPALDO (Android -> PC)
// ---------------------------------------------------------------------------
const rutaAndroidValida = (ruta) =>
    typeof ruta === 'string' && /^\/sdcard\/.+/.test(ruta) && !ruta.split('/').includes('..');

function quitarSolapadas(tareas, advertencias) {
    const norm = (t) => t.rutaAndroid.replace(/\/+$/, '') + '/';
    return tareas.filter((t, i) => {
        const cubierta = tareas.find((o, j) => {
            if (i === j) return false;
            const a = norm(t);
            const b = norm(o);
            if (a === b) return j < i;
            return a.startsWith(b);
        });
        if (cubierta && norm(cubierta) !== norm(t)) {
            advertencias.push(`${t.nombre} ya está incluida en "${cubierta.nombre}" y no se copia dos veces.`);
        }
        return !cubierta;
    });
}

/**
 * Mide una carpeta del teléfono: bytes reales (suma de los tamaños de archivo) y número
 * de archivos. Si el teléfono no admite "stat", recurre a "du" (aproximado, por bloques).
 */
async function medirDispositivo(serial, ruta, op) {
    const q = shQuote(ruta);

    const r = await ejecutarAdb(serial, ['shell', `find ${q} -type f -exec stat -c %s {} +`], { timeout: 600000, op });
    const tamanos = r.stdout
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => /^\d+$/.test(l))
        .map(Number);
    if (tamanos.length > 0) {
        return { bytes: tamanos.reduce((a, b) => a + b, 0), archivos: tamanos.length };
    }

    const cuenta = await ejecutarAdb(serial, ['shell', `find ${q} -type f | wc -l`], { timeout: 600000, op });
    const archivos = parseInt(cuenta.stdout.trim(), 10) || 0;
    if (archivos === 0) return { bytes: 0, archivos: 0 };

    const du = await ejecutarAdb(serial, ['shell', `du -sk ${q}`], { timeout: 600000, op });
    const m = du.stdout.match(/^(\d+)\s/m);
    return { bytes: m ? Number(m[1]) * 1024 : 0, archivos };
}

async function ejecutarRespaldo(event, selecciones, op) {
    const emisor = crearEmisor(event);
    const advertencias = [];

    const nombreBackup = typeof selecciones.backupName === 'string' ? selecciones.backupName.trim() : '';
    const carpetaBase = typeof selecciones.destinationPath === 'string' ? selecciones.destinationPath.trim() : '';

    if (!nombreBackupValido(nombreBackup)) {
        return { success: false, msg: 'El nombre del backup está vacío o contiene caracteres no válidos.' };
    }

    if (!carpetaBase || !path.isAbsolute(carpetaBase)) {
        return { success: false, msg: 'Selecciona una carpeta de destino válida.' };
    }

    const serial = dispositivoActual;
    if (!serial) {
        return { success: false, msg: 'No hay un dispositivo listo. Conéctalo y autoriza la depuración USB.' };
    }

    const carpetaDestinoPC = path.join(carpetaBase, nombreBackup);

    try {
        const info = await fs.lstat(carpetaDestinoPC);
        if (!info.isDirectory() || info.isSymbolicLink()) {
            return { success: false, msg: 'Ya existe un elemento con ese nombre que no es una carpeta de respaldo.' };
        }
        if (selecciones.actualizarExistente !== true) {
            return { success: false, msg: 'Ya existe un respaldo con ese nombre. Confirma si deseas actualizarlo.' };
        }
    } catch (error) {
        if (error.code !== 'ENOENT') {
            return { success: false, msg: `No se pudo comprobar el respaldo existente: ${error.message}` };
        }
    }

    // ---- Construcción de tareas ----
    let tareas = [];
    const agregarTarea = (nombre, rutaAndroid) => {
        const ruta = rutaAndroid.replace(/\/+$/, '') + '/';
        const relativa = ruta.replace(/^\/sdcard\//, '').replace(/\/+$/, '');
        const padre = path.posix.dirname(relativa);
        tareas.push({ nombre, rutaAndroid: ruta, rutaPadrePC: padre === '.' ? '' : padre });
    };

    if (selecciones.whatsapp) agregarTarea('WhatsApp', '/sdcard/Android/media/com.whatsapp/');
    if (selecciones.telegram) {
        agregarTarea('Telegram (Descargas)', '/sdcard/Download/Telegram/');
        agregarTarea('Telegram (Imágenes)', '/sdcard/Pictures/Telegram/');
        agregarTarea('Telegram (Videos)', '/sdcard/Movies/Telegram/');
    }
    if (selecciones.dcim) agregarTarea('Cámara (DCIM)', '/sdcard/DCIM/');
    if (selecciones.downloads) agregarTarea('Descargas', '/sdcard/Download/');

    if (Array.isArray(selecciones.extras)) {
        for (const carpeta of selecciones.extras) {
            if (!carpeta || !rutaAndroidValida(carpeta.ruta)) continue;
            agregarTarea(String(carpeta.nombre || carpeta.ruta), carpeta.ruta);
        }
    }

    if (tareas.length === 0) {
        return { success: false, msg: 'Selecciona al menos una opción para respaldar.' };
    }

    tareas = quitarSolapadas(tareas, advertencias);

    // ---- Análisis previo: existencia, tamaño y número de archivos ----
    const validas = [];
    for (const t of tareas) {
        if (op.cancelado) return RESULTADO_CANCELADO();
        emisor.enviar({ type: 'prepare', text: `Analizando ${t.nombre}...` });

        const existe = await ejecutarAdb(serial, ['shell', `test -d ${shQuote(t.rutaAndroid)} && echo EXISTE`], { op });
        if (op.cancelado) return RESULTADO_CANCELADO();
        if (!existe.stdout.includes('EXISTE')) {
            advertencias.push(`${t.nombre}: no existe en el dispositivo (omitida).`);
            continue;
        }

        const medidaTarea = await medirDispositivo(serial, t.rutaAndroid, op);
        if (op.cancelado) return RESULTADO_CANCELADO();
        t.bytes = medidaTarea.bytes;
        t.pesoKB = Math.max(1, Math.ceil(medidaTarea.bytes / 1024));
        t.totalArchivos = Math.max(1, medidaTarea.archivos);

        validas.push(t);
    }

    if (validas.length === 0) {
        return { success: false, msg: 'Ninguna de las carpetas seleccionadas existe en el dispositivo.' };
    }

    const totalKB = validas.reduce((suma, t) => suma + t.pesoKB, 0);

    // ---- Espacio en disco ----
    try {
        await fs.mkdir(carpetaBase, { recursive: true });
        const st = await fs.statfs(carpetaBase);
        const libre = Number(st.bavail) * Number(st.bsize);
        const necesario = totalKB * 1024 + 100 * 1024 * 1024;
        if (libre < necesario) {
            return {
                success: false,
                msg: `Espacio insuficiente en el destino: se necesitan ~${formatearBytes(necesario)} y hay ${formatearBytes(libre)}.`
            };
        }
    } catch (e) { /* si no se puede medir, continuamos */ }

    try {
        await fs.mkdir(carpetaDestinoPC, { recursive: true });
    } catch (error) {
        return { success: false, msg: `No se pudo crear la carpeta del backup: ${error.message}` };
    }

    // ---- Copia ----
    let hechosKB = 0;
    for (const [indice, tarea] of validas.entries()) {
        if (op.cancelado) return RESULTADO_CANCELADO();

        const destino = path.join(carpetaDestinoPC, ...tarea.rutaPadrePC.split('/').filter(Boolean));
        try {
            await fs.mkdir(destino, { recursive: true });
            const resultado = await transferirConProgreso({
                serial,
                accion: 'pull',
                origen: tarea.rutaAndroid,
                destino,
                tarea,
                indice,
                total: validas.length,
                baseKB: hechosKB,
                totalKB,
                op,
                emisor,
                advertencias
            });
            if (resultado.cancelado) return RESULTADO_CANCELADO();
            if (resultado.parcial) {
                advertencias.push(`${tarea.nombre}: algunos archivos no se pudieron copiar.`);
            }
        } catch (error) {
            if (op.cancelado) return RESULTADO_CANCELADO();
            return { success: false, msg: `Falló al copiar ${tarea.nombre}: ${error.message}`, warnings: advertencias };
        }
        hechosKB += tarea.pesoKB;
    }

    if (op.cancelado) return RESULTADO_CANCELADO();

    const medida = await medirCarpeta(carpetaDestinoPC, op);
    if (op.cancelado) return RESULTADO_CANCELADO();

    return {
        success: true,
        msg: advertencias.length
            ? `Respaldo completado con advertencias en ${carpetaDestinoPC}`
            : `Respaldo completado en ${carpetaDestinoPC}`,
        bytesRespaldados: medida.bytes,
        warnings: advertencias
    };
}

// ---------------------------------------------------------------------------
// RESTAURACIÓN (PC -> Android)
// ---------------------------------------------------------------------------
async function medirCarpeta(ruta, op, mapearRutas = false) {
    let bytes = 0;
    let archivos = 0;
    const bytesPorRuta = mapearRutas ? new Map() : null;
    const pila = [ruta];
    while (pila.length && !op.cancelado) {
        const actual = pila.pop();
        let entradas;
        try {
            entradas = await fs.readdir(actual, { withFileTypes: true });
        } catch (e) {
            continue;
        }
        for (const entrada of entradas) {
            const completa = path.join(actual, entrada.name);
            if (entrada.isDirectory()) {
                pila.push(completa);
            } else if (entrada.isFile()) {
                try {
                    const tamano = (await fs.stat(completa)).size;
                    bytes += tamano;
                    archivos++;
                    if (bytesPorRuta) bytesPorRuta.set(claveRutaLocal(completa), tamano);
                } catch (e) { /* ignorar */ }
            }
        }
    }
    return { bytes, archivos, bytesPorRuta };
}

async function ejecutarRestauracion(event, datos, op) {
    const emisor = crearEmisor(event);
    const advertencias = [];
    const rutaRespaldoPC = typeof datos.rutaRespaldoPC === 'string' ? datos.rutaRespaldoPC : '';

    if (!rutaRespaldoPC || !path.isAbsolute(rutaRespaldoPC) || !(await esDirectorio(rutaRespaldoPC))) {
        return { success: false, msg: 'La carpeta del respaldo no existe o no es válida.' };
    }

    const serial = dispositivoActual;
    if (!serial) {
        return { success: false, msg: 'No hay un dispositivo listo. Conéctalo y autoriza la depuración USB.' };
    }

    const elementos = await fs.readdir(rutaRespaldoPC, { withFileTypes: true });
    const carpetas = elementos.filter((e) => e.isDirectory());
    if (carpetas.length === 0) {
        return { success: false, msg: 'El respaldo seleccionado no contiene carpetas para restaurar.' };
    }

    // ---- Análisis previo ----
    const tareas = [];
    for (const carpeta of carpetas) {
        if (op.cancelado) return RESULTADO_CANCELADO();
        emisor.enviar({ type: 'prepare', text: `Analizando ${carpeta.name}...` });
        const ruta = path.join(rutaRespaldoPC, carpeta.name);
        const arbol = await construirArbol(ruta, op);
        tareas.push({
            nombre: carpeta.name,
            ruta,
            bytes: arbol.bytes,
            pesoKB: Math.max(1, Math.ceil(arbol.bytes / 1024)),
            totalArchivos: Math.max(1, arbol.totalArchivos),
            plan: planificarTarea(arbol, carpeta.name)
        });
    }
    if (op.cancelado) return RESULTADO_CANCELADO();

    const incluyeWhatsApp = await esDirectorio(path.join(rutaRespaldoPC, 'Android', 'media', WHATSAPP_PACKAGE));
    const carpetasKB = tareas.reduce((s, t) => s + t.pesoKB, 0);
    const pesoConfigKB = incluyeWhatsApp ? Math.max(1024, Math.round(carpetasKB * 0.05)) : 0;
    const totalKB = carpetasKB + pesoConfigKB;
    const totalTareas = tareas.length + (incluyeWhatsApp ? 1 : 0);

    // ---- Copia al teléfono ----
    const estimador = crearEstimador();
    let hechosKB = 0;
    for (const [indice, tarea] of tareas.entries()) {
        if (op.cancelado) return RESULTADO_CANCELADO();
        const esCarpetaAndroid = tarea.nombre === 'Android';
        const aplicarSincronizacion = !esCarpetaAndroid;
        try {
            const resultado = await transferirConProgreso({
                serial,
                accion: 'push',
                origen: tarea.ruta,
                destino: '/sdcard/',
                tarea,
                indice,
                total: totalTareas,
                baseKB: hechosKB,
                totalKB,
                op,
                emisor,
                usarSync: aplicarSincronizacion,
                estimador,
                advertencias
            });
            if (resultado.cancelado) return RESULTADO_CANCELADO();
            if (resultado.parcial) {
                advertencias.push(`${tarea.nombre}: algunos archivos no se pudieron copiar al teléfono.`);
            }
        } catch (error) {
            if (op.cancelado) return RESULTADO_CANCELADO();
            return { success: false, msg: `Falló al restaurar ${tarea.nombre}: ${error.message}`, warnings: advertencias };
        }
        hechosKB += tarea.pesoKB;
    }

    // ---- WhatsApp (instalación + permisos) ----
    if (incluyeWhatsApp) {
        if (op.cancelado) return RESULTADO_CANCELADO();
        try {
            const avisos = await configurarWhatsApp({
                serial,
                op,
                emisor,
                baseKB: hechosKB,
                pesoConfigKB,
                totalKB,
                indice: tareas.length,
                total: totalTareas
            });
            advertencias.push(...avisos);
        } catch (error) {
            if (op.cancelado) return RESULTADO_CANCELADO();
            advertencias.push(`WhatsApp: ${error.message}`);
        }
    }

    if (op.cancelado) return RESULTADO_CANCELADO();

    return {
        success: true,
        msg: advertencias.length
            ? 'Restauración finalizada con advertencias.'
            : 'Restauración finalizada exitosamente.',
        bytesRestaurados: tareas.reduce((suma, tarea) => suma + tarea.bytes, 0),
        warnings: advertencias
    };
}

async function sha256Archivo(ruta) {
    const hash = crypto.createHash('sha256');
    for await (const chunk of createReadStream(ruta)) hash.update(chunk);
    return hash.digest('hex');
}

function descargarArchivo(url, destino, op, onProgreso, redirecciones = 5) {
    return new Promise((resolve, reject) => {
        const parcial = `${destino}.part`;

        const req = https.get(url, { headers: { 'User-Agent': 'das-hopper' } }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                res.resume();
                if (!res.headers.location || redirecciones <= 0) {
                    return reject(new Error('Demasiadas redirecciones al descargar.'));
                }
                const siguiente = new URL(res.headers.location, url).toString();
                return descargarArchivo(siguiente, destino, op, onProgreso, redirecciones - 1).then(resolve, reject);
            }

            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`Fallo en la descarga. Código HTTP: ${res.statusCode}`));
            }

            const total = parseInt(res.headers['content-length'], 10) || 0;
            let descargado = 0;
            res.on('data', (chunk) => {
                descargado += chunk.length;
                if (total) onProgreso(descargado / total);
            });

            pipeline(res, createWriteStream(parcial))
                .then(async () => {
                    if (total && descargado !== total) throw new Error('Descarga incompleta.');
                    await fs.rename(parcial, destino);
                    resolve();
                })
                .catch(async (error) => {
                    await fs.rm(parcial, { force: true }).catch(() => {});
                    reject(error);
                });
        });

        op.request = req;
        req.setTimeout(30000, () => req.destroy(new Error('Tiempo de espera agotado al descargar.')));
        req.on('error', reject);
    });
}

async function configurarWhatsApp({ serial, op, emisor, baseKB, pesoConfigKB, totalKB, indice, total }) {
    const avisos = [];
    const info = { taskName: 'Configurando WhatsApp', taskIndex: indice, taskCount: total };
    const avanzar = (fraccion, texto, forzar = true) => {
        const hechoKB = baseKB + pesoConfigKB * fraccion;
        const payload = {
            percent: porcentaje(hechoKB, totalKB),
            bytesDone: hechoKB * 1024,
            bytesTotal: totalKB * 1024,
            ...info
        };
        if (forzar) emisor.enviar({ type: 'progress', ...payload });
        else emisor.progreso(payload);
        if (texto) emisor.enviar({ type: 'log', text: texto });
    };

    emisor.enviar({ type: 'task-start', ...info });
    avanzar(0, 'Comprobando si WhatsApp está instalado...');

    const lista = await ejecutarAdb(serial, ['shell', 'pm', 'list', 'packages', WHATSAPP_PACKAGE], { op });
    if (op.cancelado) return avisos;
    if (!lista.ok) {
        avisos.push('No se pudo comprobar si WhatsApp está instalado; se omitió la configuración.');
        return avisos;
    }

    const instalado = lista.stdout.split(/\r?\n/).some((l) => l.trim() === `package:${WHATSAPP_PACKAGE}`);

    if (!instalado) {
        const cache = path.join(app.getPath('userData'), 'whatsapp.apk');
        const legado = path.join(__dirname, 'bin', 'whatsapp.apk');

        let apk = null;
        for (const candidato of [cache, legado]) {
            try {
                await fs.access(candidato);
                apk = candidato;
                break;
            } catch (e) { /* probar el siguiente */ }
        }

        if (apk) {
            avanzar(0.7, 'Usando instalador almacenado en caché...');
        } else {
            await fs.mkdir(path.dirname(cache), { recursive: true });
            avanzar(0, 'Descargando WhatsApp...');
            let ultimoPct = -1;
            await descargarArchivo(WHATSAPP_APK_URL, cache, op, (fraccion) => {
                const pct = Math.round(fraccion * 100);
                avanzar(fraccion * 0.7, pct !== ultimoPct ? `Descargando WhatsApp... ${pct}%` : null, false);
                ultimoPct = pct;
            });
            apk = cache;
        }

        if (WHATSAPP_APK_SHA256) {
            const hash = await sha256Archivo(apk);
            if (hash.toLowerCase() !== WHATSAPP_APK_SHA256.toLowerCase()) {
                if (apk === cache) await fs.rm(cache, { force: true }).catch(() => {});
                throw new Error('El APK de WhatsApp no coincide con el SHA-256 esperado; no se instaló.');
            }
        } else {
            avisos.push('El APK de WhatsApp se instaló sin verificar su integridad (SHA-256 no configurado).');
        }

        if (op.cancelado) return avisos;
        avanzar(0.75, 'Instalando WhatsApp... (puede pedirte confirmar en el teléfono)');
        const instalacion = await ejecutarAdb(serial, ['install', '-r', apk], { timeout: 10 * 60 * 1000, op });
        if (op.cancelado) return avisos;

        if (!/Success/i.test(instalacion.stdout)) {
            avisos.push(`No se pudo instalar WhatsApp: ${ultimasLineas(instalacion.stdout + ' ' + instalacion.stderr) || 'error desconocido'}`);
            return avisos;
        }
    }

    avanzar(0.9, 'Aplicando permisos de almacenamiento...');
    const permisos = [
        'READ_MEDIA_IMAGES',
        'READ_MEDIA_VIDEO',
        'READ_MEDIA_AUDIO',
        'READ_EXTERNAL_STORAGE',
        'WRITE_EXTERNAL_STORAGE'
    ];
    for (const permiso of permisos) {
        if (op.cancelado) return avisos;
        // Algunos permisos no existen según la versión de Android; el error se ignora a propósito.
        await ejecutarAdb(serial, ['shell', 'pm', 'grant', WHATSAPP_PACKAGE, `android.permission.${permiso}`], { op });
    }

    avanzar(1, 'Permisos aplicados. WhatsApp listo.');
    emisor.enviar({ type: 'task-complete', ...info });
    return avisos;
}