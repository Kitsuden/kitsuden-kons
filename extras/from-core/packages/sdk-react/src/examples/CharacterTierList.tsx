/**
 * Example — a character tier list with drag and drop
 * ============================================================================
 *
 * Copy the PATTERN, not the design. What matters in this file:
 *
 *   · `useTierList` brings the list already grouped by rows (`vista.filas`) and the
 *     unplaced elements (`vista.withoutRanking`).
 *   · `colocar(itemId, tierId)` is optimistic: the item moves when dropped and
 *     goes back to its place if the API rejects it. The error must be caught in order
 *     to show it, because the hook rethrows it.
 *   · `null` as the row returns the element to the unranked pool.
 *
 * The styles are the minimum needed for the structure to be understood.
 */

import { useState, type DragEvent } from "react";

import { useTierList, type KitsudenConfig, type TierItem } from "../index.js";

export function CharacterTierList({ config, slug }: { config: KitsudenConfig; slug: string }) {
  const { view: view, loading, error, place } = useTierList(config, slug);
  const [warning, setWarning] = useState<string | null>(null);

  if (loading) return <p>Loading…</p>;
  if (error) return <p role="alert">{error.message}</p>;
  if (!view) return null;

  const onDrop = (tierId: string | null) => (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    const itemId = event.dataTransfer.getData("text/plain");
    if (!itemId) return;
    setWarning(null);
    place(itemId, tierId).catch((e: Error) => setWarning(e.message));
  };

  return (
    <div>
      {warning && <p role="alert">{warning}</p>}

      {view.rows.map(({ tier, items }) => (
        <section
          key={tier.id}
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop(tier.id)}
          style={{
            display: "flex",
            gap: 8,
            minHeight: 64,
            borderLeft: `8px solid ${tier.color ?? "#888"}`,
          }}
        >
          <strong style={{ width: 40 }}>{tier.label}</strong>
          {items.map((item) => (
            <Card key={item.id} item={item} />
          ))}
        </section>
      ))}

      <section onDragOver={(e) => e.preventDefault()} onDrop={onDrop(null)}>
        <h3>Unranked</h3>
        {view.withoutRanking.map((item) => (
          <Card key={item.id} item={item} />
        ))}
      </section>
    </div>
  );
}

function Card({ item }: { item: TierItem }) {
  return (
    <figure draggable onDragStart={(e) => e.dataTransfer.setData("text/plain", item.id)}>
      {item.imageUrl ? <img src={item.imageUrl} alt="" width={48} height={48} /> : null}
      <figcaption>{item.label}</figcaption>
    </figure>
  );
}
