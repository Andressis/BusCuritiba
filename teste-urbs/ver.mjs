import pkg from "xz-decompress";
const { XzReadableStream } = pkg;

const base = "http://dadosabertos.c3sl.ufpr.br/curitibaurbs/2026_10_03_";
const r = await fetch(base + "pontosLinha.json.xz");
const lista = JSON.parse(await new Response(new XzReadableStream(r.body)).text());

console.log("Total de registros:", lista.length);
const linhas = new Set(lista.map((p) => p.COD));
console.log("Linhas diferentes:", linhas.size);

const l050 = lista.filter((p) => p.COD === "050");
console.log("Registros da linha 050:", l050.length);
console.log("Pontos únicos da 050:", new Set(l050.map((p) => p.NUM)).size);
console.log("Itinerários da 050:", [...new Set(l050.map((p) => p.ITINERARY_ID))]);
