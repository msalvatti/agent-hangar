/**
 * The layout contract both picker triggers keep, so a long name cannot escape its container.
 *
 * Layer: shared (styling).
 */

/**
 * Classes every picker trigger carries.
 *
 * A trigger holds a name it does not control the length of — `owner/repository` can be sixty
 * characters — and it is dropped into containers it does not control either: a wrapping flex row
 * in the composer, a two-column grid cell in the job dialog. The label inside already truncates,
 * but truncation only ever applies to the space a box was actually given, so both ways a button
 * can claim more space than its container has must be shut:
 *
 * - `min-w-0` lets it shrink as a flex item, whose automatic minimum size is otherwise the width
 *   of the whole unwrapped label;
 * - `max-w-full` caps it everywhere else, where an `inline-flex` box is sized shrink-to-fit and
 *   would otherwise grow to that same width and spill over whatever sits beside it.
 *
 * Without the cap the trigger renders on top of its neighbour instead of ellipsising, which is
 * what a grid cell — a block box, not a flex item — gets. The cap is what has to be here rather
 * than on the container: it also bounds the width the trigger contributes to that container's own
 * intrinsic size, which a `min-width` on the container cannot do from the outside.
 */
export const PICKER_TRIGGER_CLASS = 'min-w-0 max-w-full justify-between';
