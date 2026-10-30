import { useEffect, useState } from "react";
import { colorToRgb, normalizeColor, rgbToColor } from "./colorValues";

export default function ColorPicker({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: string;
  onChange: (color: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const color = normalizeColor(value) || "#234e70";
  const [hex, setHex] = useState(color);
  const [rgb, setRgb] = useState(colorToRgb(color).map(String));
  useEffect(() => {
    setHex(color);
    setRgb(colorToRgb(color).map(String));
  }, [color]);
  return (
    <details className="color-picker">
      <summary
        aria-label={label}
        aria-disabled={disabled}
        onClick={(event) => {
          if (disabled) event.preventDefault();
        }}
      >
        <span
          className="color-picker-swatch"
          style={{ backgroundColor: color }}
        />
        {color.toUpperCase()}
      </summary>
      <div className="color-picker-panel" role="group" aria-label={label}>
        <input
          className="color-picker-wheel"
          type="color"
          value={color}
          disabled={disabled}
          aria-label={`${label}: colour wheel`}
          onChange={(event) => onChange(event.target.value)}
        />
        <label>
          Hex
          <input
            value={hex}
            disabled={disabled}
            maxLength={7}
            spellCheck={false}
            aria-label={`${label}: hex`}
            aria-invalid={!normalizeColor(hex)}
            onChange={(event) => {
              setHex(event.target.value);
              const valid =
                /^#[0-9a-f]{6}$/i.test(event.target.value) &&
                normalizeColor(event.target.value);
              if (valid) onChange(valid);
            }}
            onBlur={() => {
              const valid = normalizeColor(hex);
              if (valid) onChange(valid);
              else setHex(color);
            }}
          />
        </label>
        <div className="color-picker-rgb">
          {["R", "G", "B"].map((channel, index) => (
            <label key={channel}>
              {channel}
              <input
                type="number"
                min="0"
                max="255"
                step="1"
                disabled={disabled}
                value={rgb[index]}
                aria-label={`${label}: ${channel}`}
                onChange={(event) => {
                  const next = rgb.map((v, i) =>
                    i === index ? event.target.value : v,
                  );
                  setRgb(next);
                  const valid =
                    next.every((v) => v.trim() !== "") &&
                    rgbToColor(next.map(Number));
                  if (valid) onChange(valid);
                }}
                onBlur={() => setRgb(colorToRgb(color).map(String))}
              />
            </label>
          ))}
        </div>
      </div>
    </details>
  );
}
