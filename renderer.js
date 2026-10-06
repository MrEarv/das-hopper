const { ipcRenderer } = require('electron'); 

const btnBackup = document.getElementById('backup-btn'); // ID corregido
//const btnRestore = document.getElementById('restore-btn');
const deviceStatus = document.getElementById('device-status');
const statusText = document.getElementById('status');

// Arreglo para guardar las carpetas que el usuario va apilando
let carpetasExtra = [];
const btnAddFolder = document.getElementById('btn-add-folder');
const contenedorApiladas = document.getElementById('carpetas-apiladas');
const selectFolders = document.getElementById('android-folders-list');

// Evento para el botón de "➕ Añadir"
btnAddFolder.addEventListener('click', () => {
    const ruta = selectFolders.value;
    const nombre = selectFolders.options[selectFolders.selectedIndex]?.text;

    // Si no seleccionó nada o eligió el texto "Cargando...", ignoramos el clic
    if (!ruta || ruta === "") return;

    // Evitamos que agregue la misma carpeta dos veces
    const yaExiste = carpetasExtra.find(c => c.ruta === ruta);
    if (yaExiste) return;

    // La guardamos en nuestro arreglo
    carpetasExtra.push({ nombre: nombre, ruta: ruta });
    
    // Dibujamos las burbujas
    renderizarCarpetas();
});

// Función que dibuja las burbujas en pantalla
function renderizarCarpetas() {
    contenedorApiladas.innerHTML = ''; // Limpiamos el contenedor
    
    carpetasExtra.forEach((carpeta, index) => {
        // Creamos la burbuja
        const badge = document.createElement('div');
        badge.className = 'folder-badge';
        badge.innerHTML = `
            <span>📁 ${carpeta.nombre}</span>
            <span class="quitar" title="Quitar">✖</span>
        `;

        // Le damos vida al botón de la "X" para poder borrarla
        badge.querySelector('.quitar').addEventListener('click', () => {
            carpetasExtra.splice(index, 1); // La borramos del arreglo
            renderizarCarpetas(); // Volvemos a dibujar
        });

        contenedorApiladas.appendChild(badge);
    });
}

// Este es tu Event Listener que escucha el canal 'estado-dispositivo'
ipcRenderer.on('estado-dispositivo', (event, data) => {
    
    if (data.conectado) {
        // --- EL CELULAR SE CONECTÓ ---
        deviceStatus.innerText = `📱 Conectado: ${data.id}`;
        deviceStatus.classList.add('success');
        
        // Encendemos los botones
        btnBackup.disabled = false;
        //btnRestore.disabled = false;
        
        statusText.innerText = "Dispositivo detectado. Listo para operar.";
        cargarCarpetasAndroid(); // Cargamos las carpetas del celular
        
    } else {
        // --- EL CELULAR SE DESCONECTÓ ---
        deviceStatus.innerText = "Estado: Buscando dispositivo...";
        deviceStatus.classList.remove('success');
        
        // Apagamos los botones para evitar errores
        btnBackup.disabled = true;
        //btnRestore.disabled = true;
        
        statusText.innerText = "Por favor, conecta tu dispositivo y activa la Depuración USB.";
        document.getElementById('android-folders-list').innerHTML = '<option value="">Esperando dispositivo...</option>';
    }
});

// 2. Darle acción al botón de Backup
btnBackup.addEventListener('click', async () => {
    // 1. Recolectamos el estado de los checkboxes (true o false)
    const selecciones = {
        whatsapp: document.getElementById('whatsapp-data').checked,
        telegram: document.getElementById('telegram-data').checked,
        dcim: document.getElementById('dcim-data').checked,
        downloads: document.getElementById('downloads-data').checked,
        extras: carpetasExtra
    };

    // 2. Verificamos que al menos haya elegido uno
    if (!selecciones.whatsapp && !selecciones.telegram && !selecciones.dcim && !selecciones.downloads && !selecciones.extras.length) {
        statusText.innerText = "❌ Selecciona al menos una opción para respaldar.";
        return;
    }

    // 3. Bloqueamos la UI para evitar doble clic
    btnBackup.disabled = true;
    btnBackup.innerText = "⏳ Extrayendo datos... Espera...";
    statusText.innerText = "No desconectes el cable por nada del mundo.";

    // 4. Le enviamos el objeto 'selecciones' al backend
    const respuesta = await ipcRenderer.invoke('start-backup', selecciones);

    // 5. Manejamos el resultado final
    if (respuesta.success) {
        statusText.innerText = "✅ " + respuesta.msg;
        btnBackup.innerText = "⬇️ Backup Exitoso";
    } else {
        statusText.innerText = "❌ Error: " + respuesta.msg;
        btnBackup.innerText = "⬇️ Intentar de nuevo";
        btnBackup.disabled = false;
    }
});

// Agrega este listener para leer los porcentajes que mande el backend
const progresoTexto = document.getElementById('backup-status');
ipcRenderer.on('backup-progress', (event, texto) => {
    const linea = texto.trim().split('\n').pop(); // Agarramos la última línea
    if (linea) {
        progresoTexto.innerText = linea;
    }
});

async function cargarCarpetasAndroid() {
    const selectBox = document.getElementById('android-folders-list');
    selectBox.innerHTML = '<option value="">Cargando...</option>';
    
    // Le pedimos al backend la lista
    const respuesta = await ipcRenderer.invoke('get-android-folders');
    
    if (respuesta.success && respuesta.carpetas.length > 0) {
        selectBox.innerHTML = ''; // Limpiamos el select
        
        // Llenamos el select con las carpetas reales del celular
        respuesta.carpetas.forEach(carpeta => {
            const opcion = document.createElement('option');
            // Guardamos la ruta real en el value (/sdcard/Music/)
            opcion.value = `/sdcard/${carpeta}/`; 
            // Mostramos solo el nombre (Music)
            opcion.innerText = carpeta;
            selectBox.appendChild(opcion);
        });
    } else {
        selectBox.innerHTML = '<option value="">Error al leer almacenamiento</option>';
    }
}
