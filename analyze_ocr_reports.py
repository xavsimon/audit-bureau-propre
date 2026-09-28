#!/usr/bin/env python3
"""Summarize local OCR benchmark ZIPs without extracting or printing image/text data."""

from __future__ import annotations

import argparse
import json
import math
import statistics
import zipfile
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CONTEXT_FIELDS = {
    "deviceModel": "Modèle",
    "lighting": "Luminosité",
    "glare": "Reflets",
    "focus": "Netteté",
    "framing": "Cadrage",
    "angle": "Inclinaison",
}


def number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if math.isfinite(value) else None


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * fraction) - 1)]


def load_archives(directory: Path) -> tuple[list[dict[str, Any]], list[str]]:
    reports: list[dict[str, Any]] = []
    problems: list[str] = []
    for archive_path in sorted(directory.rglob("*.zip")):
        try:
            with zipfile.ZipFile(archive_path) as archive:
                report = json.loads(archive.read("report.json"))
            if not isinstance(report, dict) or not isinstance(report.get("battery"), dict):
                raise ValueError("structure report/battery invalide")
            schema = report.get("schema", "inconnu")
            if schema not in {
                "audit-bureau-propre-ocr-benchmark/v1",
                "audit-bureau-propre-ocr-benchmark/v2",
            }:
                raise ValueError(f"schéma non pris en charge: {schema}")
            battery = report["battery"]
            samples = battery.get("samples")
            if not isinstance(samples, list):
                raise ValueError("battery.samples absent ou invalide")
            reports.append({"path": archive_path, "report": report, "samples": samples})
        except (OSError, KeyError, ValueError, json.JSONDecodeError, zipfile.BadZipFile) as error:
            problems.append(f"{archive_path.name}: {error}")
    return reports, problems


def sample_metrics(samples: list[dict[str, Any]]) -> dict[str, Any]:
    valid_samples = [sample for sample in samples if isinstance(sample, dict)]
    exact = [sample for sample in valid_samples if isinstance(sample.get("exactMatch"), bool)]
    cer_values = [value for sample in valid_samples if (value := number(sample.get("characterErrorRate"))) is not None]
    elapsed_values = [value for sample in valid_samples if (value := number(sample.get("elapsedMs"))) is not None]
    failed = [sample for sample in exact if not sample["exactMatch"]]
    return {
        "samples": len(valid_samples),
        "scored": len(exact),
        "exact": sum(sample["exactMatch"] for sample in exact),
        "failed": failed,
        "cer": cer_values,
        "elapsed": elapsed_values,
    }


def display_rate(exact: int, scored: int) -> str:
    if not scored:
        return "n/d"
    return f"{100 * exact / scored:.1f} % ({exact}/{scored})"


def format_ms(value: float | None) -> str:
    return "n/d" if value is None else f"{value:.0f} ms"


def format_percent(value: float | None) -> str:
    return "n/d" if value is None else f"{value * 100:.1f} %"


def make_markdown(reports: list[dict[str, Any]], problems: list[str]) -> str:
    lines = [
        "# Analyse des rapports de qualité OCR",
        "",
        f"Généré le {datetime.now(timezone.utc).isoformat(timespec='seconds')}.",
        "Les photos ne sont pas extraites; les valeurs attendues, OCR brut et valeurs reconnues ne sont pas affichés.",
        "",
    ]
    if not reports:
        lines.extend(["Aucune archive v1/v2 valide trouvée.", ""])
    else:
        lines.extend([
            f"Archives valides: **{len(reports)}** · Échantillons: **{sum(len(item['samples']) for item in reports)}**.",
            "",
            "## Résultats par archive",
            "",
            "| Archive | Schéma | Version app | Catégorie | Série | Exactitude | CER médian | Latence médiane / p95 |",
            "| --- | --- | --- | --- | --- | ---: | ---: | ---: |",
        ])
        report_metrics: list[dict[str, Any]] = []
        category_groups: dict[str, list[dict[str, Any]]] = defaultdict(list)
        context_groups: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
        failure_rotations: Counter[str] = Counter()
        success_rotations: Counter[str] = Counter()
        for item in reports:
            report = item["report"]
            battery = report["battery"]
            metrics = sample_metrics(item["samples"])
            category = str(battery.get("category") or "unknown")
            context = battery.get("captureContext") if isinstance(battery.get("captureContext"), dict) else {}
            entry = {**metrics, "category": category, "context": context, "report": report, "path": item["path"]}
            report_metrics.append(entry)
            category_groups[category].append(entry)
            for field in CONTEXT_FIELDS:
                value = context.get(field)
                if value not in (None, "", "unknown"):
                    context_groups[(field, str(value))].append(entry)
            app_version = report.get("application", {}).get("version", "n/d")
            lines.append(
                f"| {item['path'].name} | {report.get('schema', 'n/d')} | {app_version} | {category} "
                f"| {report.get('experimentId') or 'n/d'} | {display_rate(metrics['exact'], metrics['scored'])} "
                f"| {format_percent(statistics.median(metrics['cer']) if metrics['cer'] else None)} "
                f"| {format_ms(statistics.median(metrics['elapsed']) if metrics['elapsed'] else None)} / "
                f"{format_ms(percentile(metrics['elapsed'], 0.95))} |"
            )
            for sample in metrics["failed"]:
                selected = sample.get("diagnostics", {}).get("selectedDetection", {})
                rotation = selected.get("rotation") if isinstance(selected, dict) else None
                if rotation is not None:
                    failure_rotations[str(rotation)] += 1
            for sample in item["samples"]:
                if isinstance(sample, dict) and sample.get("exactMatch") is True:
                    selected = sample.get("diagnostics", {}).get("selectedDetection", {})
                    rotation = selected.get("rotation") if isinstance(selected, dict) else None
                    if rotation is not None:
                        success_rotations[str(rotation)] += 1

        lines.extend(["", "## Synthèse par catégorie", "", "| Catégorie | Exactitude | CER médian | Latence médiane / p95 |", "| --- | ---: | ---: | ---: |"])
        for category, entries in sorted(category_groups.items()):
            scored = sum(entry["scored"] for entry in entries)
            exact = sum(entry["exact"] for entry in entries)
            cers = [value for entry in entries for value in entry["cer"]]
            elapsed = [value for entry in entries for value in entry["elapsed"]]
            lines.append(
                f"| {category} | {display_rate(exact, scored)} "
                f"| {format_percent(statistics.median(cers) if cers else None)} "
                f"| {format_ms(statistics.median(elapsed) if elapsed else None)} / {format_ms(percentile(elapsed, 0.95))} |"
            )

        if context_groups:
            lines.extend(["", "## Résultats selon le contexte déclaré", "", "| Champ | Valeur | Exactitude | Échantillons |", "| --- | --- | ---: | ---: |"])
            for (field, value), entries in sorted(context_groups.items()):
                scored = sum(entry["scored"] for entry in entries)
                exact = sum(entry["exact"] for entry in entries)
                label = CONTEXT_FIELDS[field]
                lines.append(f"| {label} | {value} | {display_rate(exact, scored)} | {scored} |")
        else:
            lines.extend(["", "## Résultats selon le contexte déclaré", "", "Aucun contexte v2 renseigné dans les archives valides."])

        total_failed = sum(len(entry["failed"]) for entry in report_metrics)
        total_scored = sum(entry["scored"] for entry in report_metrics)
        lines.extend(["", "## Motifs observés et pistes d'essai", ""])
        if not total_failed:
            lines.append("Aucun échec exact parmi les échantillons évaluables. Ajouter des cas difficiles contrôlés avant de conclure à une amélioration.")
        else:
            lines.append(f"{total_failed} échec(s) sur {total_scored} échantillon(s) évaluables. Examiner localement les photos correspondant aux IDs ci-dessous; ne pas inférer la cause à partir du CER seul.")
            for entry in report_metrics:
                if not entry["failed"]:
                    continue
                ids = [str(sample.get("id", "sans-id")) for sample in entry["failed"]]
                lines.append(f"- `{entry['path'].name}` ({entry['category']}): {len(ids)} échec(s), IDs `{', '.join(ids)}`.")
            context_contrasts: dict[str, list[tuple[str, float, int, int]]] = defaultdict(list)
            for (field, value), entries in context_groups.items():
                scored = sum(entry["scored"] for entry in entries)
                exact = sum(entry["exact"] for entry in entries)
                if len(entries) >= 2 and scored >= 2:
                    context_contrasts[field].append((value, exact / scored, exact, scored))
            for field, groups in sorted(context_contrasts.items()):
                if len(groups) < 2:
                    continue
                ordered = sorted(groups, key=lambda group: group[1])
                lowest = ordered[0]
                highest = ordered[-1]
                if highest[1] - lowest[1] >= 0.2:
                    values = "; ".join(
                        f"`{value}`: {display_rate(exact, scored)}"
                        for value, _, exact, scored in ordered
                    )
                    lines.append(
                        f"- Axe à tester: {CONTEXT_FIELDS[field].lower()} présente un écart descriptif "
                        f"entre batteries ({values}). Répéter un A/B sur les mêmes images avant d'en tirer une conclusion."
                    )
            if failure_rotations:
                failures = ", ".join(f"{rotation}°: {count}" for rotation, count in sorted(failure_rotations.items()))
                successes = ", ".join(f"{rotation}°: {count}" for rotation, count in sorted(success_rotations.items())) or "aucun"
                lines.append(f"- Rotations sélectionnées: échecs [{failures}]; réussites [{successes}]. Tester une correction d'orientation uniquement si les images confirment cette piste.")
            if any(sample.get("error") for entry in report_metrics for sample in entry["failed"]):
                lines.append("- Au moins une erreur d'exécution OCR est présente; séparer ces cas des erreurs de lecture lors du diagnostic.")
        lines.extend(["", "Une corrélation de contexte n'est pas une preuve causale. Comparer des batteries représentatives, et garder hors du rapport les données personnelles."])

    if problems:
        lines.extend(["", "## Archives ignorées", ""])
        lines.extend(f"- `{problem}`" for problem in problems)
    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--reports-dir", type=Path, default=Path("rapports OCR"), help="Dossier contenant les ZIP de rapports (défaut: rapports OCR)")
    parser.add_argument("--output", type=Path, help="Chemin de sortie Markdown (défaut: dans le dossier des rapports)")
    args = parser.parse_args()
    if not args.reports_dir.is_dir():
        parser.error(f"Dossier introuvable: {args.reports_dir}")
    reports, problems = load_archives(args.reports_dir)
    output = args.output or args.reports_dir / f"analyse_ocr_{datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}.md"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(make_markdown(reports, problems), encoding="utf-8")
    print(f"Analyse écrite: {output} ({len(reports)} archive(s) valide(s), {len(problems)} ignorée(s))")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
