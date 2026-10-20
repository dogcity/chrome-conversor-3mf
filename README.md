# Conversor 3MF a Snapmaker U1 y Bambu A1

Extensión de Chrome que convierte archivos `.3mf` al formato de la **Snapmaker U1** o de la **Bambu Lab A1**. Toda la conversión ocurre en el navegador: los archivos no se envían a ningún servidor.

## Funciones

- Captura las descargas `.3mf` o permite arrastrar archivos locales a la ventana de la extensión.
- Convierte varios archivos a la vez: los que tienen los mismos filamentos y colores se procesan juntos; los demás, uno por uno.
- Destino Snapmaker U1 o Bambu A1, con perfiles de impresión y de filamento propios para la A1.
- Elige el perfil de filamento según el tipo del archivo de origen (PLA, PETG).
- Conserva los parámetros del modelo que definió su autor (altura de capa, paredes, relleno, soportes, brim, alisado); nunca copia velocidades, temperaturas ni G-code.
- Centra los objetos en la cama de destino en proyectos de una sola cama.
- Si el archivo de salida ya existe, agrega un correlativo (`-2`, `-3`, …).

## Instalación para desarrollo

1. Abre `chrome://extensions` y activa el **modo de desarrollador**.
2. Haz clic en **Cargar descomprimida** y elige la carpeta `extension/`.

## Pruebas

```sh
node --test tests/*.test.js
```

Los perfiles de la A1 (`extension/src/lib/targets/a1-profiles.js`) se generan a partir de proyectos de Bambu Studio:

```sh
python3 -I scripts/extract_a1_profiles.py <carpeta con proyectos .3mf de la A1>
```

## Créditos y licencia

Este proyecto es una versión modificada de [3mf-to-u1](https://github.com/ericreid/3mf-to-u1), de Eric Reid, publicado bajo la licencia GPL-3.0.

Modificado por José Ortega en 2026: destino Bambu Lab A1, conversión por lotes, parámetros equivalentes entre impresoras, centrado en la cama, nombres de salida correlativos, nueva identidad visual e interfaz en español.

Copyright (C) 2026 José Ortega (modificaciones).

Este programa es software libre: puedes redistribuirlo y/o modificarlo según los términos de la Licencia Pública General GNU, versión 3, publicada por la Free Software Foundation. Consulta el archivo [LICENSE](LICENSE).

La biblioteca [JSZip](https://stuk.github.io/jszip/) (`extension/vendor/jszip.min.js`) se distribuye bajo licencia MIT o GPL-3.0, a elección.
