<div align="center">
  <img src="./assets/icon.png" alt="Das-Hopper Logo" width="120">
  <h1>Das-Hopper ADB Tool</h1>
  <p><b>Una herramienta gráfica, minimalista y profesional para respaldos de Android por ADB.</b></p>
</div>

---

Das-Hopper es una aplicación de escritorio diseñada para hacer respaldos y restauraciones de dispositivos Android de forma segura, rápida y sin depender de la nube ni del protocolo MTP; que para varias archivos o carpetas completas se queda muy lento, llegando hasta atorarse indefinidamente. 

## Características Principales

- **Arquitectura Híbrida Inteligente:** Ahorra tiempo sincronizando (`--sync`) archivos pesados como la galería (DCIM) y las descargas, mientras fuerza la sobrescritura exacta de bases de datos críticas (como WhatsApp) para evitar corrupción.
- **Instalación de WhatsApp Offline:** Descarga, instala y aplica los permisos necesarios para WhatsApp automáticamente durante la restauración.
- **Carpetas Extra Personalizadas:** Explora y añade directorios adicionales directamente desde la memoria de tu dispositivo.
- **Portabilidad:** Disponible en instalador clásico o como versión *Portable* para llevar en un USB.
- **Diseño Moderno:** Interfaz plana (Flat UI) y fluida, construida con Electron y CSS nativo.

## Instalación y Uso

1. Ve a la sección de [Releases](../../releases/latest) a la derecha de esta página.
2. Descarga `Das-Hopper-Setup-1.0.0.exe` (para instalar) o la versión `Portable`.
3. Conecta tu celular a la PC con un buen cable USB.
4. **Habilita la Depuración USB** en las Opciones de Desarrollador de tu Android.
5. Abre Das-Hopper y autoriza la conexión en la pantalla de tu celular.

## Tecnologías Utilizadas
- [Electron](https://www.electronjs.org/)
- Node.js
- Android Debug Bridge (ADB)
- Interfaz nativa en HTML5, CSS3 y JavaScript puro.

---
*Desarrollado con ❤️ por [MrEarv](https://github.com/MrEarv)*