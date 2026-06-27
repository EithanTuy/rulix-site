type BrandTone = "light" | "dark";
type BrandSize = "auth" | "topbar" | "rail" | "compact";

interface BrandLogoProps {
  tone?: BrandTone;
  size?: BrandSize;
  product?: string;
  className?: string;
}

export function BrandLogo({ tone = "dark", size = "topbar", product, className }: BrandLogoProps) {
  const wordmark = tone === "light" ? "/brand/rulix-wordmark-light.png" : "/brand/rulix-wordmark-dark.png";
  const mark = tone === "light" ? "/brand/rulix-mark-light.png" : "/brand/rulix-mark-dark.png";
  const classes = ["brand-logo", `brand-logo--${tone}`, `brand-logo--${size}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} aria-label={product ? `Rulix ${product}` : "Rulix"}>
      <img className="brand-logo-mark" src={mark} alt="" />
      <img className="brand-logo-wordmark" src={wordmark} alt="" />
      {product && <span className="brand-logo-product">{product}</span>}
    </div>
  );
}
