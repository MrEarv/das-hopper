# Das-Hopper

Aplicación de escritorio para Windows que utiliza Android Debug Bridge (ADB) para respaldar y restaurar archivos entre un dispositivo Android y el equipo.

## Funciones

- Respaldar las carpetas de medios de WhatsApp, carpetas de Telegram, DCIM y Descargas.
- Añadir otras carpetas disponibles en el almacenamiento compartido del dispositivo.
- Guardar respaldos en una ubicación elegida y actualizar uno existente sin borrar los archivos que no se vuelvan a copiar.
- Restaurar las carpetas de un respaldo, con progreso y opción para cancelar.
- Instalar WhatsApp y solicitar permisos de almacenamiento durante la restauración si el respaldo contiene `Android/media/com.whatsapp`.

## Requisitos

- Windows.
- Un dispositivo Android con **Depuración USB** habilitada.
- Una conexión a Internet si es necesario descargar el APK de WhatsApp durante una restauración.

Al conectar el dispositivo, acepta en el teléfono la solicitud para autorizar la depuración USB. Si hay más de un dispositivo listo conectado, la aplicación puede elegir uno automáticamente; conecta solo el dispositivo que quieras usar.


## Crear un respaldo

1. Conecta y autoriza el dispositivo.
2. En la pestaña **Respaldar**, selecciona las categorías que quieras incluir. Puedes añadir carpetas extra.
3. Elige la ubicación de destino y, si quieres, escribe un nombre para el respaldo.
4. Pulsa **Realizar Backup** y espera a que termine. Mantén el teléfono conectado durante la operación.

El respaldo contiene archivos del almacenamiento compartido, no una copia integral del teléfono. La opción de WhatsApp copia sus archivos de medios en `Android/media/com.whatsapp`; **no incluye por sí misma las conversaciones, la base de datos privada ni los ajustes de la aplicación**.

La estructura local conserva las rutas de origen. Por ejemplo:

```text
Mi respaldo/
├── DCIM/
├── Download/
│   └── Telegram/
├── Android/
│   └── media/
│       └── com.whatsapp/
└── Pictures/
    └── Telegram/
```

Si ya existe una carpeta con el nombre elegido, la aplicación solicita confirmación antes de combinar los archivos. La actualización no elimina archivos que ya estaban en el respaldo y no se reemplazan durante la copia.

## Restaurar un respaldo

1. Selecciona la ubicación donde están guardados los respaldos.
2. Abre la pestaña **Restaurar** y elige un respaldo de la lista.
3. Confirma la operación y espera a que termine.

Las carpetas de primer nivel del respaldo se copian a `/sdcard/` en el dispositivo. Para las carpetas comunes, ADB sincroniza los archivos y no elimina del teléfono los que no están en el respaldo. La carpeta `Android` se restaura sin ese modo de sincronización, por lo que sus archivos pueden sobrescribir archivos con el mismo nombre. La restauración no tiene deshacer ni ofrece una reversión automática.

Si el respaldo incluye medios de WhatsApp y la aplicación no está instalada, Das-Hopper intenta usar un APK guardado en caché o descargarlo desde la URL configurada en `main.js`. Después intenta aplicar permisos que pueden variar según la versión de Android.


## Cancelación y archivos parciales

Una operación cancelada o interrumpida puede dejar archivos incompletos en el destino o en el dispositivo. No uses un respaldo recién cancelado como si estuviera completo; comprueba su contenido o vuelve a ejecutar la operación. La aplicación no crea una copia temporal transaccional ni revierte cambios ya realizados.

## Solución de problemas

- **No aparece el dispositivo:** comprueba el cable y la Depuración USB, acepta la autorización en el teléfono y vuelve a conectar.
- **Aparece como no autorizado:** desbloquea el teléfono y acepta el diálogo de autorización de depuración USB.
- **No hay espacio suficiente:** elige una ubicación con espacio libre en el equipo o libera almacenamiento en el teléfono antes de restaurar.
- **Falla la descarga o instalación de WhatsApp:** comprueba la conexión a Internet y vuelve a intentarlo. La instalación puede requerir confirmación en el teléfono.

## Privacidad

Los respaldos se guardan en la ubicación que elijas. Protégelos como cualquier otro archivo personal: pueden contener fotos, vídeos y otros datos del dispositivo. Das-Hopper no cifra los respaldos.
