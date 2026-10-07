const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { execFile, spawn } = require('child_process');
const fs = require('fs/promises');
const { createWriteStream, createReadStream } = require('fs');
const { pipeline } = require('stream/promises');
const crypto = require('crypto');
const path = require('path');
const https = require('https');

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------
const adbPath = path.join(__dirname, 'bin', 'adb.exe');

const WHATSAPP_PACKAGE = 'com.whatsapp';
const WHATSAPP_APK_URL = 'https://github.com/MrEarv/das-hopper/releases/download/v1.0.0-asset/whatsapp.apk';
// Recomendado: pega aquí el SHA-256 (hex) del APK que consideres confiable.
// Si se deja vacío, el APK se instala SIN verificar su integridad.
const WHATSAPP_APK_SHA256 = '';

// ---------------------------------------------------------------------------
// Estado global
// ---------------------------------------------------------------------------
let dispositivoActual = null; // serial del dispositivo en estado "device"
const operacionesActivas = new Map(); // senderId -> { tipo, cancelado, proceso, request }

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
        height: 780,
        webPreferences: {
            nodeIntegration: true, // Permite usar módulos de Node en el HTML
            contextIsolation: false // Simplifica el proyecto (ver notas de seguridad)
        },
        frame: true,
        autoHideMenuBar: true,
        center: true
    });

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

function crearEmisor(event) {
    let ultimoEnvio = 0;
    const enviar = (payload) => {
        if (!event.sender.isDestroyed()) event.sender.send('backup-progress', payload);
    };
    return {
        enviar,
        // Versión con límite de frecuencia para no saturar la UI
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
                win.webContents.send(
                    'estado-dispositivo',
                    sel.id ? { conectado: true, id: sel.id } : { conectado: false, estado: sel.estado }
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
function transferirADB(serial, accion, origen, destino, op, { onArchivo, onTexto } = {}) {
    return new Promise((resolve, reject) => {
        const args = accion === 'pull'
            ? ['-s', serial, 'pull', '-a', origen, destino]
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
            reject(new Error(ultimasLineas(cola) || `ADB terminó con código ${code}`));
        });
    });
}

async function transferirConProgreso({ serial, accion, origen, destino, tarea, indice, total, baseKB, totalKB, op, emisor }) {
    const info = { taskName: tarea.nombre, taskIndex: indice, taskCount: total };
    emisor.enviar({ type: 'task-start', ...info });
    emisor.enviar({ type: 'progress', percent: porcentaje(baseKB, totalKB), ...info });

    let archivosVistos = 0;
    let archivoActual = '';

    const resultado = await transferirADB(serial, accion, origen, destino, op, {
        onArchivo: ({ pct, archivo }) => {
            if (archivo !== archivoActual) {
                archivoActual = archivo;
                archivosVistos++;
            }
            const fraccion = Math.min(1, (archivosVistos - 1 + pct / 100) / tarea.totalArchivos);
            emisor.progreso({
                percent: porcentaje(baseKB + tarea.pesoKB * fraccion, totalKB),
                file: archivo,
                filePercent: pct,
                ...info
            });
        },
        onTexto: (linea) => emisor.enviar({ type: 'log', text: linea })
    });

    if (resultado.cancelado) return resultado;

    emisor.enviar({ type: 'progress', percent: porcentaje(baseKB + tarea.pesoKB, totalKB), ...info });
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
            if (a === b) return j < i; // duplicado exacto: se conserva el primero
            return a.startsWith(b); // t está dentro de o
        });
        if (cubierta && norm(cubierta) !== norm(t)) {
            advertencias.push(`${t.nombre} ya está incluida en "${cubierta.nombre}" y no se copia dos veces.`);
        }
        return !cubierta;
    });
}

async function ejecutarRespaldo(event, selecciones, op) {
    const emisor = crearEmisor(event);
    const advertencias = [];

    const nombreBackup = typeof selecciones.backupName === 'string' ? selecciones.backupName.trim() : '';
    const carpetaBase = typeof selecciones.destinationPath === 'string' ? selecciones.destinationPath.trim() : '';

    if (
        !nombreBackup ||
        nombreBackup.length > 100 ||
        /[<>:"/\\|?*\x00-\x1f]/.test(nombreBackup) ||
        /[. ]$/.test(nombreBackup) ||
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/i.test(nombreBackup)
    ) {
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

    // Evita mezclar un respaldo nuevo con uno existente
    try {
        await fs.access(carpetaDestinoPC);
        return { success: false, msg: 'Ya existe un respaldo con ese nombre. Elige otro nombre.' };
    } catch (e) { /* no existe: correcto */ }

    // ---- Construcción de tareas ----
    let tareas = [];
    const agregarTarea = (nombre, rutaAndroid) => {
        const ruta = rutaAndroid.replace(/\/+$/, '') + '/';
        const relativa = ruta.replace(/^\/sdcard\//, '').replace(/\/+$/, '');
        const padre = path.posix.dirname(relativa); // la ruta local replica el directorio padre
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

        const du = await ejecutarAdb(serial, ['shell', `du -sk ${shQuote(t.rutaAndroid)}`], { timeout: 300000, op });
        const m = du.stdout.match(/^(\d+)\s/m);
        t.pesoKB = m ? Math.max(1, Number(m[1])) : 1;

        const cuenta = await ejecutarAdb(
            serial,
            ['shell', `find ${shQuote(t.rutaAndroid)} -type f | wc -l`],
            { timeout: 300000, op }
        );
        if (op.cancelado) return RESULTADO_CANCELADO();
        t.totalArchivos = Math.max(1, parseInt(cuenta.stdout.trim(), 10) || 1);

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
                emisor
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

    return {
        success: true,
        msg: advertencias.length
            ? `Respaldo completado con advertencias en ${carpetaDestinoPC}`
            : `Respaldo completado en ${carpetaDestinoPC}`,
        warnings: advertencias
    };
}

// ---------------------------------------------------------------------------
// RESTAURACIÓN (PC -> Android)
// ---------------------------------------------------------------------------
async function medirCarpeta(ruta, op) {
    let bytes = 0;
    let archivos = 0;
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
                    bytes += (await fs.stat(completa)).size;
                    archivos++;
                } catch (e) { /* ignorar */ }
            }
        }
    }
    return { bytes, archivos };
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
        const medida = await medirCarpeta(ruta, op);
        tareas.push({
            nombre: carpeta.name,
            ruta,
            pesoKB: Math.max(1, Math.ceil(medida.bytes / 1024)),
            totalArchivos: Math.max(1, medida.archivos)
        });
    }
    if (op.cancelado) return RESULTADO_CANCELADO();

    const incluyeWhatsApp = await esDirectorio(path.join(rutaRespaldoPC, 'Android', 'media', WHATSAPP_PACKAGE));
    const carpetasKB = tareas.reduce((s, t) => s + t.pesoKB, 0);
    const pesoConfigKB = incluyeWhatsApp ? Math.max(1024, Math.round(carpetasKB * 0.05)) : 0;
    const totalKB = carpetasKB + pesoConfigKB;
    const totalTareas = tareas.length + (incluyeWhatsApp ? 1 : 0);

    // ---- Copia al teléfono ----
    let hechosKB = 0;
    for (const [indice, tarea] of tareas.entries()) {
        if (op.cancelado) return RESULTADO_CANCELADO();
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
                emisor
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
    // fraccion: 0..1 dentro del paso de configuración
    const avanzar = (fraccion, texto) => {
        emisor.enviar({ type: 'progress', percent: porcentaje(baseKB + pesoConfigKB * fraccion, totalKB), ...info });
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

    // Coincidencia exacta: evita confundir com.whatsapp con com.whatsapp.w4b
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
            await descargarArchivo(WHATSAPP_APK_URL, cache, op, (fraccion) => {
                avanzar(fraccion * 0.7);
                emisor.enviar({ type: 'log', text: `Descargando WhatsApp... ${Math.round(fraccion * 100)}%` });
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