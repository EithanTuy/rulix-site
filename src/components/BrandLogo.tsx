type BrandTone = "light" | "dark" | "adaptive";
type BrandSize = "auth" | "topbar" | "rail" | "compact";

interface BrandLogoProps {
  tone?: BrandTone;
  size?: BrandSize;
  product?: string;
  className?: string;
}

export function BrandLogo({ tone = "dark", size = "topbar", product, className }: BrandLogoProps) {
  const isAdaptive = tone === "adaptive";
  const wordmark = tone === "light" ? "/brand/rulix-wordmark-light.png" : "/brand/rulix-wordmark-dark.png";
  const classes = ["brand-logo", `brand-logo--${tone}`, `brand-logo--${size}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <span className={classes} role="img" aria-label={product ? `Rulix ${product}` : "Rulix"}>
      {isAdaptive ? (
        <>
          <img className="brand-logo-wordmark brand-logo-asset-light" src="/brand/rulix-wordmark-light.png" alt="" />
          <img className="brand-logo-wordmark brand-logo-asset-dark" src="/brand/rulix-wordmark-dark.png" alt="" />
        </>
      ) : (
        <img className="brand-logo-wordmark" src={wordmark} alt="" />
      )}
      {product && <span className="brand-logo-product">{product}</span>}
    </span>
  );
}
