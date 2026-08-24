package main

import _ "embed"

// DejaVu Sans Condensed (OFL) — UTF-8 шрифт для PDF с кириллицей.
// fpdf встроенные шрифты (Helvetica и т.п.) поддерживают только Latin-1.
//go:embed fonts/DejaVuSansCondensed.ttf
var dejaVuFont []byte

//go:embed fonts/DejaVuSansCondensed-Bold.ttf
var dejaVuFontBold []byte
