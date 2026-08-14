# SRD attribution

The JSON files in this folder are adapted from the **System Reference Document
5.1 ("SRD 5.1")** by Wizards of the Coast LLC, available under the **Creative
Commons Attribution 4.0 International License (CC-BY-4.0)**.

> This work includes material taken from the System Reference Document 5.1
> ("SRD 5.1") by Wizards of the Coast LLC and available at
> https://dnd.wizards.com/resources/systems-reference-document. The SRD 5.1 is
> licensed under the Creative Commons Attribution 4.0 International License
> available at https://creativecommons.org/licenses/by/4.0/legalcode.

Official CC source: [SRD 5.1 PDF](https://media.dndbeyond.com/compendium-images/srd/5.1/SRD_CC_v5.1.pdf).

## Data source

The machine-readable JSON was sourced from the open-source project
**5e-bits/5e-database** (https://github.com/5e-bits/5e-database), which packages
the SRD 5.1. The project's code is MIT-licensed; the SRD game content it contains
is under CC-BY-4.0 as above.

The exact upstream commit this dataset was pulled from is recorded in
[`.dataset-ref`](.dataset-ref).

The bundled `monsters.json` has SHA-256
`CBF1B6D0A94F6E13AFD1480D647D288C61BA0DDC3D3A7842D1501852DC954237`.

Files are the English (`src/2014/en`) edition. A Brazilian-Portuguese edition
(`src/2014/pt-BR`) also exists upstream and could be added as a language toggle.

## Changes to the licensed material

The SRD tables and stat blocks were converted, reformatted, and normalized as
JSON for application use. When a monster is placed on a map, 3DX creates a
compact snapshot and removes upstream API URLs, image references, and fields
the tabletop does not use. No SRD monster artwork is included.
