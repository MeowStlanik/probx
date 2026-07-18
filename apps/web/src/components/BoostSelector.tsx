"use client";

interface BoostSelectorProps {
  value: number;
  onChange: (value: number) => void;
  maxBoost: number;
}

const boosts = [1, 1.5, 2, 3, 5];

export function BoostSelector({ value, onChange, maxBoost }: BoostSelectorProps) {
  return (
    <div className="segmentedControl" role="group" aria-label="Select Micro Boost">
      {boosts.map((boost) => {
        const disabled = boost > maxBoost;
        return (
          <button
            aria-pressed={value === boost}
            className={value === boost ? "selected" : ""}
            disabled={disabled}
            key={boost}
            onClick={() => onChange(boost)}
            title={disabled ? `Max available boost is ${maxBoost.toFixed(2)}x` : `${boost}x boost`}
            type="button"
          >
            {boost}x
          </button>
        );
      })}
    </div>
  );
}
