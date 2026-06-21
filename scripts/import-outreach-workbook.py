import json
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"


def column_index(reference: str) -> int:
    result = 0
    for character in re.match(r"[A-Z]+", reference).group(0):
        result = result * 26 + ord(character) - 64
    return result - 1


def read_sheet(workbook_path: Path, sheet_name: str) -> list[dict[str, str]]:
    with zipfile.ZipFile(workbook_path) as archive:
        shared_strings = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            shared_strings = [
                "".join(node.text or "" for node in item.iter(f"{{{NS}}}t"))
                for item in root
            ]

        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        relationship_map = {
            item.attrib["Id"]: item.attrib["Target"] for item in relationships
        }
        sheet = next(
            item
            for item in workbook.find(f"{{{NS}}}sheets")
            if item.attrib["name"] == sheet_name
        )
        target = relationship_map[sheet.attrib[f"{{{REL_NS}}}id"]].lstrip("/")
        if not target.startswith("xl/"):
            target = f"xl/{target}"
        root = ET.fromstring(archive.read(target))

        rows: list[dict[int, str]] = []
        for row in root.findall(f".//{{{NS}}}sheetData/{{{NS}}}row"):
            values: dict[int, str] = {}
            for cell in row.findall(f"{{{NS}}}c"):
                index = column_index(cell.attrib.get("r", "A1"))
                value_node = cell.find(f"{{{NS}}}v")
                inline_node = cell.find(f"{{{NS}}}is")
                value = ""
                if cell.attrib.get("t") == "s" and value_node is not None:
                    value = shared_strings[int(value_node.text)]
                elif cell.attrib.get("t") == "inlineStr" and inline_node is not None:
                    value = "".join(
                        node.text or "" for node in inline_node.iter(f"{{{NS}}}t")
                    )
                elif value_node is not None:
                    value = value_node.text or ""
                values[index] = value
            if values:
                rows.append(values)

    headers = [rows[0].get(index, "") for index in range(max(rows[0]) + 1)]
    return [
        {
            headers[index]: value
            for index, value in row.items()
            if index < len(headers) and headers[index]
        }
        for row in rows[1:]
    ]


def persona(row: dict[str, str]) -> str:
    email = row.get("primary_contact_email", "").lower()
    if "researchsecurity" in email or "research.security" in email:
        return "Research security director"
    if "export" in email:
        return "Export-control officer"
    if row.get("organization_type") == "regulated_company":
        return "Government contracts / compliance"
    return "Compliance / legal operations"


def main() -> None:
    workbook_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    rows = read_sheet(workbook_path, "Priority Leads")
    leads = []
    seen_emails = set()
    for row in rows:
        email = row.get("primary_contact_email", "").strip().lower()
        if not email or email in seen_emails:
            continue
        seen_emails.add(email)
        leads.append(
            {
                "leadId": row.get("lead_id", ""),
                "organization": row.get("organization", ""),
                "organizationType": row.get("organization_type", ""),
                "segment": row.get("segment", ""),
                "website": row.get("website", ""),
                "domain": row.get("domain", ""),
                "city": row.get("city", ""),
                "state": row.get("state", ""),
                "source": row.get("source", ""),
                "sourceUrl": row.get("source_url", ""),
                "fitScore": int(float(row.get("fit_score", "0") or 0)),
                "priority": row.get("priority", ""),
                "email": email,
                "status": row.get("status", ""),
                "outreachAngle": row.get("outreach_angle", ""),
                "owner": row.get("owner", ""),
                "notes": row.get("notes", ""),
                "persona": persona(row),
            }
        )

    output = (
        'import type { OutreachLead } from "./types";\n\n'
        f"export const outreachLeads: OutreachLead[] = {json.dumps(leads, indent=2, ensure_ascii=False)};\n"
    )
    output_path.write_text(output, encoding="utf-8")
    print(f"Imported {len(leads)} unique outreach-ready leads into {output_path}.")


if __name__ == "__main__":
    main()
