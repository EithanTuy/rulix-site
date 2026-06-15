import type { MemoRecord } from "../types";

export const reviewFixtures: MemoRecord[] = [
  {
    id: "fixture-cryo-2026-0417",
    title: "Compact Cryostat System Memo",
    itemFamily: "Cryogenic laboratory equipment",
    owner: "Fixture Reviewer",
    updatedAt: "2026-05-14",
    documentCode: "CRYO-2026-0417",
    status: "needs-info",
    attachments: ["vendor-spec-cryostat.pdf", "research-use-statement.docx"],
    memoText: `1.0 Purpose
This memo describes a compact cryogenic system ("System") designed to achieve and maintain a base temperature of 1.2 K for research use in a laboratory environment.

2.0 System Description
The System integrates a closed-cycle pulse tube refrigerator with a two-stage Joule-Thomson (JT) expansion circuit. The first stage precools to ~15 K; the second stage provides final cooling to 1.2 K at the sample space.

Cooling Capacity: 20 mW at 1.2 K.

Refrigerant: Helium (He-4), high purity.

Operating Pressure: 0.8 MPa (first stage), 0.3 MPa (second stage after JT valve).

System includes a vacuum-insulated dewar, multi-layer insulation, and active temperature sensors with PID control.

The system is not specifically designed for the production of military items. It is intended for fundamental research.

3.0 Performance
Base Temperature: 1.2 K
Temperature Stability: +/- 5 mK at 1.2 K
Cooldown Time: ~8 hours from 300 K to 1.2 K
Hold Time: >48 hours at 1.2 K with full charge

4.0 Use & End-Use
Intended for university research. Not for use in weapons, missile, or nuclear applications.

5.0 Memo Conclusion
The item is self-classified as ECCN 3A001.a.5 because it is cryogenic equipment with controlled low-temperature performance. No license analysis is included in this memo.`
  },
  {
    id: "fixture-camera-2026-0412",
    title: "High-Speed Camera Module",
    itemFamily: "Imaging sensor module",
    owner: "Fixture Reviewer",
    updatedAt: "2026-05-13",
    documentCode: "CAM-2026-0412",
    status: "ready",
    attachments: ["camera-datasheet.pdf"],
    memoText: `1.0 Item
The item is a high-speed camera module used for materials research and laboratory diagnostics.

2.0 Technical Characteristics
Maximum frame rate is 190,000 frames per second at reduced resolution. Full-frame resolution is 1280 x 1024 pixels. The module includes a CMOS sensor and USB-C data interface.

3.0 Classification Analysis
The memo proposes ECCN 6A003 because imaging equipment may be controlled when frame rate, resolution, and sensor characteristics exceed listed thresholds.

4.0 Missing Information
The memo does not include spectral sensitivity, radiation hardening, environmental ruggedization, or the complete operating temperature range.

5.0 Conclusion
The item is recommended for further review under Category 6 before relying on the ECCN.`
  },
  {
    id: "fixture-quantum-2026-0409",
    title: "Quantum Control Electronics",
    itemFamily: "Signal/control electronics",
    owner: "Fixture Reviewer",
    updatedAt: "2026-05-12",
    documentCode: "QCTRL-2026-0409",
    status: "needs-info",
    attachments: ["control-stack-spec.xlsx"],
    memoText: `The item is a rack-mounted quantum control electronics stack used to generate synchronized microwave and RF control pulses for qubit experiments. The memo claims EAR99 based on academic research use. It does not provide timing resolution, phase noise, channel count, waveform memory, encryption features, or whether the firmware is separately provided.`
  },
  {
    id: "fixture-laser-2026-0406",
    title: "Ultrafast Laser Source",
    itemFamily: "Laser source",
    owner: "Fixture Reviewer",
    updatedAt: "2026-05-09",
    documentCode: "LAS-2026-0406",
    status: "conflict",
    attachments: ["laser-quote.pdf", "restricted-use-email.eml"],
    memoText: `The item is an ultrafast tunable laser source with femtosecond pulse duration. The memo concludes EAR99 because it will be used in a university optics lab. It lists wavelength range and average power but omits pulse energy, repetition rate, beam quality, tuning range, and whether any military end-use restrictions apply.`
  },
  {
    id: "fixture-vac-2026-0401",
    title: "Vacuum Pump Assembly",
    itemFamily: "General laboratory equipment",
    owner: "Fixture Reviewer",
    updatedAt: "2026-05-08",
    documentCode: "VAC-2026-0401",
    status: "ready",
    attachments: ["pump-manual.pdf"],
    memoText: `The item is a standard oil-free scroll vacuum pump assembly for general laboratory vacuum service. It has no embedded encryption, no radiation hardening, no military design intent, and no listed performance characteristics identified in the reviewed CCL categories. The memo proposes EAR99 after manufacturer classification review and internal CCL screening.`
  }
];
