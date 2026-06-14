import type { CorpusSnapshot } from "../types";

export const officialCorpus: CorpusSnapshot = {
  id: "official-corpus-2026-06-seed",
  label: "Official Corpus v2026.06",
  generatedAt: "2026-06-14T00:00:00-04:00",
  checksum: "seed-corpus-official-sources-v1",
  documents: [
    {
      id: "ear-734-3",
      title: "15 CFR 734.3 - Items subject to the EAR",
      authority: "EAR",
      snapshotDate: "2026-06-14",
      url: "https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-734/section-734.3"
    },
    {
      id: "ear-774-supp-4",
      title: "15 CFR Part 774 Supplement No. 4 - Commerce Control List Order of Review",
      authority: "EAR",
      snapshotDate: "2026-06-14",
      url: "https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-774/appendix-Supplement%20No.%204%20to%20Part%20774"
    },
    {
      id: "itar-120",
      title: "22 CFR Part 120 - ITAR Purpose and Definitions",
      authority: "ITAR",
      snapshotDate: "2026-06-14",
      url: "https://www.ecfr.gov/current/title-22/chapter-I/subchapter-M/part-120"
    },
    {
      id: "itar-121",
      title: "22 CFR Part 121 - United States Munitions List",
      authority: "ITAR",
      snapshotDate: "2026-06-14",
      url: "https://www.ecfr.gov/current/title-22/chapter-I/subchapter-M/part-121"
    },
    {
      id: "bis-classify",
      title: "BIS - Classify Your Item",
      authority: "BIS",
      snapshotDate: "2026-06-14",
      url: "https://www.bis.gov/licensing/classify-your-item"
    },
    {
      id: "ita-eccn",
      title: "International Trade Administration - Determine Your ECCN",
      authority: "ITA",
      snapshotDate: "2026-06-14",
      url: "https://www.trade.gov/how-do-i-determine-my-export-control-classification-number-eccn"
    }
  ],
  chunks: [
    {
      id: "chunk-ear-subject",
      documentId: "ear-734-3",
      title: "Items subject to the EAR",
      locator: "15 CFR 734.3",
      url: "https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-734/section-734.3",
      text: "The EAR applies to items in the United States, certain U.S.-origin items wherever located, and certain foreign-produced items under EAR jurisdiction.",
      tags: ["jurisdiction", "ear", "scope"]
    },
    {
      id: "chunk-order-of-review",
      documentId: "ear-774-supp-4",
      title: "Order of Review",
      locator: "15 CFR Part 774 Supp. No. 4",
      url: "https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-774/appendix-Supplement%20No.%204%20to%20Part%20774",
      text: "The CCL order of review requires checking whether an item is described on the USML before completing EAR/CCL classification.",
      tags: ["jurisdiction", "itar", "order-of-review"]
    },
    {
      id: "chunk-3a001-cryogenic",
      documentId: "ear-774-supp-4",
      title: "Category 3 - Electronics candidate control",
      locator: "ECCN 3A001.a.5 seed chunk",
      url: "https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-774/appendix-Supplement%20No.%204%20to%20Part%20774",
      text: "Cryogenic or superconductive equipment and components may require Category 3 review when performance, temperature, and component function meet controlled parameters.",
      tags: ["3A001", "cryogenic", "electronics", "performance"]
    },
    {
      id: "chunk-6a003-camera",
      documentId: "ear-774-supp-4",
      title: "Category 6 - Sensors and lasers candidate control",
      locator: "ECCN 6A003 seed chunk",
      url: "https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-774/appendix-Supplement%20No.%204%20to%20Part%20774",
      text: "High-speed cameras, imaging equipment, and related components require Category 6 review when frame rate, resolution, sensitivity, and ruggedization thresholds are relevant.",
      tags: ["6A003", "camera", "sensor", "imaging"]
    },
    {
      id: "chunk-6a005-laser",
      documentId: "ear-774-supp-4",
      title: "Category 6 - Lasers candidate control",
      locator: "ECCN 6A005 seed chunk",
      url: "https://www.ecfr.gov/current/title-15/subtitle-B/chapter-VII/subchapter-C/part-774/appendix-Supplement%20No.%204%20to%20Part%20774",
      text: "Laser systems and components require Category 6 review using wavelength, output power or energy, pulse duration, repetition rate, and tuning characteristics.",
      tags: ["6A005", "laser", "optics", "performance"]
    },
    {
      id: "chunk-source-classification",
      documentId: "bis-classify",
      title: "Classification paths",
      locator: "BIS Classify Your Item",
      url: "https://www.bis.gov/licensing/classify-your-item",
      text: "Classification can use manufacturer or source classification, self-classification, or a BIS commodity classification request such as CCATS.",
      tags: ["process", "ccats", "self-classification"]
    },
    {
      id: "chunk-eccn-method",
      documentId: "ita-eccn",
      title: "ECCN determination guidance",
      locator: "ITA ECCN guidance",
      url: "https://www.trade.gov/how-do-i-determine-my-export-control-classification-number-eccn",
      text: "ECCN determination compares product characteristics against the Commerce Control List, including category and product group.",
      tags: ["eccn", "ccl", "method"]
    },
    {
      id: "chunk-usml-check",
      documentId: "itar-121",
      title: "USML review",
      locator: "22 CFR Part 121",
      url: "https://www.ecfr.gov/current/title-22/chapter-I/subchapter-M/part-121",
      text: "The United States Munitions List identifies defense articles and related technical data subject to ITAR jurisdiction.",
      tags: ["itar", "usml", "defense-article"]
    },
    {
      id: "chunk-itar-release",
      documentId: "itar-120",
      title: "ITAR definitions and release risk",
      locator: "22 CFR Part 120",
      url: "https://www.ecfr.gov/current/title-22/chapter-I/subchapter-M/part-120",
      text: "ITAR definitions and release concepts matter when controlled technical data could be disclosed to unauthorized persons or systems.",
      tags: ["itar", "release", "technical-data"]
    }
  ]
};

export const getSourceChunk = (id: string) =>
  officialCorpus.chunks.find((chunk) => chunk.id === id);

