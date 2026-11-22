# Verificación estricta del smoke

El perfil smoke debe ejecutarse con un VU y cuatro iteraciones secuenciales, una por tipo. Cada iteración debe comprobar:

1. Login aceptado y sesión autenticada.
2. Gestión, mes, oficina, entidad y área disponibles según `config/environment.json`, sin modificarlos.
3. Correlativo y fecha devueltos por el ambiente.
4. ID interno de cada cuenta obtenido en su búsqueda y nombre esperado.
5. Balance antes del POST y respuesta de guardado con ID interno.
6. Tipo, fecha, glosa de cabecera y líneas, cuentas, importes y totales en la página persistida.
7. PDF con HTTP 200, `Content-Type: application/pdf` y firma `%PDF`.

La validación del PDF confirma descarga y formato; no interpreta el texto ni el diseño del documento.

El flujo no reintenta un guardado. Si la respuesta no permite extraer el ID, queda marcado como ambiguo y debe revisarse la persistencia por glosa antes de cualquier decisión manual. Un error posterior al guardado conserva el ID, glosa y estado en el manifiesto.

El smoke inicial se ejecutó contra el ambiente con cuatro iteraciones autorizadas. Una excepción del runtime ocurrió al iniciar la consulta persistida, después de recibir los IDs de guardado. Se corrigió la construcción de la URL en el código; no se repitió el flujo de creación para respetar el máximo de cuatro altas. Las cuatro altas se verificaron después mediante consultas autenticadas de solo lectura, incluidas persistencia exacta y PDF. El manifiesto detallado queda en `results/`, que está excluido de Git.
