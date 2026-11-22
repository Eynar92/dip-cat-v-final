# Trazabilidad de k6 Studio

La grabación principal del 22/11/2026 cubrió el recorrido Traspaso desde el acceso hasta persistencia e impresión. La grabación comparativa consultó los tipos 1, 2 y 4, sin guardar altas adicionales. Las evidencias completas, capturas de pantalla, grabaciones privadas y HAR permanecen en el directorio de antecedentes y no se copian al repositorio.

El único registro que creó la grabación principal fue Traspaso T09-05301, ID interno 18350. Se conserva en el ambiente y no se utiliza como entrada para el proyecto. La comparativa no guardó comprobantes. El contexto observado fue gestión 2026, mes 9, oficina y área ADM CETOF, entidad CETOF; el flujo debe comprobar la sesión vigente sin cambiar esos valores.

## Rutas observadas

`session.php` autentica; `modulo.php?codigo=3` abre Contabilidad; `index.php?opcion=listComprobantes` presenta el listado; `comprobantes/register.php` abre el formulario; `ajaxCorrelativo.php` y `ajax_fecha_comprobante.php` devuelven valores dependientes del tipo y contexto; `ajaxCuentaContable.php` prepara cada línea; `ajaxBusquedaCuenta.php` devuelve la selección de cuenta; `save.php` recibe multipart y responde HTML/JavaScript con la referencia de impresión; `editar.php` puede redirigir con JavaScript a `edit_prueba.php`; `imp.php` entrega el PDF.

El servidor puede devolver campos de cuenta vacíos en la página de edición y presentar los datos guardados en llamadas `setBusquedaCuentaEdit(...)`. La verificación del proyecto debe contemplar ambas representaciones. HTTP 200 por sí solo no acredita el resultado de negocio.

Los valores exportados por Studio para fecha, correlativo, IDs de cuentas, contexto, glosa e ID de comprobante son estáticos. No se ejecutó ni se copió el script exportado. El flujo del repositorio vuelve a obtener los datos dinámicos antes de guardar.

## Decisiones de alcance

- Plantillas de dos líneas balanceadas por 10 para los cuatro tipos.
- Métricas etiquetadas solo con operación y tipo; las glosas quedan en el manifiesto.
- Ingreso NR conserva su tipo y su excepción de validación de libreta bancaria.
- Los perfiles de carga son configuraciones provisionales; solo se autorizó un smoke local limitado.

No se incorporan HAR, Generator, respuestas HTTP, capturas de pantalla, sesiones ni resultados de las exploraciones. El resumen no modifica las evidencias ni el plan originales.
