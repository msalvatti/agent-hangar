/**
 * The active model line of the credentials card.
 *
 * Layer: component.
 */

/** Props of {@link ModelLine}. */
export interface ModelLineProps {
  model: string;
}

/**
 * Shows the active model id and where it comes from.
 *
 * @param props - The model id.
 */
export function ModelLine({ model }: ModelLineProps) {
  return (
    <p className="text-sm">
      Model <span className="font-mono text-[13px]">{model}</span>{' '}
      <span className="text-muted-foreground">(from OPENAI_MODEL)</span>
    </p>
  );
}
