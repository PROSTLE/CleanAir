"use client";

import React from "react";
import Image from "next/image";

interface VayuSetuLogoProps {
  size?: number;
  className?: string;
  variant?: "light" | "dark";
  showText?: boolean;
  style?: React.CSSProperties;
}

export default function VayuSetuLogo({
  size = 40,
  className = "",
  variant = "light",
  showText = false,
  style = {},
}: VayuSetuLogoProps) {
  const imgSrc = showText
    ? "/logo_full.png"
    : variant === "dark"
      ? "/logo_dark.png"
      : "/logo.png";

  // Aspect ratio of the mark is ~3.25 : 1 (width : height)
  const height = size;
  const width = showText ? Math.round(size * 2) : Math.round(size * 3.25);

  return (
    <div
      className={`inline-flex items-center select-none ${className}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        verticalAlign: "middle",
        ...style,
      }}
    >
      <Image
        src={imgSrc}
        alt="VayuSetu Logo"
        width={width}
        height={height}
        priority
        style={{
          height: `${height}px`,
          width: "auto",
          maxHeight: `${height}px`,
          objectFit: "contain",
          filter: variant === "dark" ? "brightness(1.2) drop-shadow(0 0 8px rgba(74,222,128,0.25))" : "none",
        }}
      />
    </div>
  );
}
