<?php
// Formulario de contacto de aguilarealmexicana.org
// Solo acepta POST. Valida campos, bloquea spam simple (campo trampa) y
// envía el mensaje al correo del programa con Reply-To del remitente.

declare(strict_types=1);

const DESTINO   = 'luisfelipe.lozano@aguilarealmexicana.org';
const REMITENTE = 'no-reply@aguilarealmexicana.org';
const PAGINA    = 'contacto.html';

$temas_validos = [
    'donativo'   => 'Donativo',
    'memoria'    => 'Donativo en memoria o en honor',
    'equipo'     => 'Donación de equipo de campo',
    'patrocinio' => 'Patrocinio empresarial',
    'colaboracion' => 'Colaboración',
    'prensa'     => 'Prensa',
    'otro'       => 'Otro',
];

function volver(string $estado): void {
    header('Location: ' . PAGINA . '?estado=' . $estado, true, 303);
    exit;
}

function limpio(string $texto): string {
    // Quita saltos de línea para evitar inyección de cabeceras
    return trim(str_replace(["\r", "\n"], ' ', $texto));
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    exit('Método no permitido.');
}

// Campo trampa: los humanos no lo llenan
if (!empty($_POST['sitio_web'] ?? '')) {
    volver('ok'); // respondemos como si todo estuviera bien
}

$nombre  = limpio((string)($_POST['nombre'] ?? ''));
$correo  = limpio((string)($_POST['correo'] ?? ''));
$tema    = (string)($_POST['tema'] ?? '');
$mensaje = trim((string)($_POST['mensaje'] ?? ''));

if ($nombre === '' || mb_strlen($nombre) > 100) volver('error');
if (!filter_var($correo, FILTER_VALIDATE_EMAIL) || mb_strlen($correo) > 150) volver('error');
if (!array_key_exists($tema, $temas_validos)) volver('error');
if ($mensaje === '' || mb_strlen($mensaje) > 3000) volver('error');

$asunto = '[Sitio] ' . $temas_validos[$tema] . ' — ' . $nombre;
$cuerpo = "Nombre: $nombre\n"
        . "Correo: $correo\n"
        . "Tema: " . $temas_validos[$tema] . "\n"
        . "IP: " . ($_SERVER['REMOTE_ADDR'] ?? 'desconocida') . "\n\n"
        . $mensaje . "\n";

$cabeceras = [
    'From: Águila Real Mexicana <' . REMITENTE . '>',
    'Reply-To: ' . $nombre . ' <' . $correo . '>',
    'Content-Type: text/plain; charset=UTF-8',
    'X-Mailer: PHP/' . PHP_VERSION,
];

$enviado = mail(DESTINO, '=?UTF-8?B?' . base64_encode($asunto) . '?=', $cuerpo, implode("\r\n", $cabeceras));

volver($enviado ? 'ok' : 'error');
