import { Icon } from '@/components/workspace';

/**
 * A material issue as one quiet line: the outlined warning icon, the text and, at the end, an
 * optional section link or button. `blocking` turns the icon red, for a true blocker only.
 * `field` is the smaller form placed under a form control; tie it to the control with
 * aria-describedby through `id`.
 */
export function WarningLine({
  children,
  action,
  blocking = false,
  field = false,
  as: Tag = 'p',
  id,
  role,
}: {
  children: React.ReactNode;
  action?: React.ReactNode;
  blocking?: boolean;
  field?: boolean;
  as?: 'p' | 'li' | 'div';
  id?: string;
  role?: 'alert' | 'status';
}) {
  const className = ['warning-line', blocking ? 'blocking' : '', field ? 'field' : '']
    .filter(Boolean)
    .join(' ');
  return (
    <Tag className={className} id={id} role={role}>
      <Icon kind="warning" />
      <span>{children}</span>
      {action ? <span className="warning-action">{action}</span> : null}
    </Tag>
  );
}
