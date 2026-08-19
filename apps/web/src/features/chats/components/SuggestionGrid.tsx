/**
 * The four starter-prompt cards, laid out 4-up on desktop and collapsing to 1-up on phones.
 *
 * Layer: feature (component).
 */
import { SUGGESTIONS } from '../lib/suggestions';

import { SuggestionCard } from './SuggestionCard';

/** Props of {@link SuggestionGrid}. */
export interface SuggestionGridProps {
  /** Receives the starter prompt of the chosen card. */
  onSelect: (prompt: string) => void;
}

/**
 * Renders {@link SUGGESTIONS} as a responsive grid of {@link SuggestionCard}s.
 *
 * @param props - The select handler.
 */
export function SuggestionGrid({ onSelect }: SuggestionGridProps) {
  return (
    <div className="grid w-full grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
      {SUGGESTIONS.map((suggestion) => (
        <SuggestionCard
          key={suggestion.id}
          title={suggestion.title}
          icon={suggestion.icon}
          tone={suggestion.tone}
          onSelect={() => {
            onSelect(suggestion.prompt);
          }}
        />
      ))}
    </div>
  );
}
