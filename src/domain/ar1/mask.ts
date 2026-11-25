import { maskIdentity } from '../resolution/particulars';
import type { Ar1Data, IdentityCells } from './data';

const HIDDEN_DATE = '**/**/****';
/** The identity columns hidden from staff without `view_identity` (IDENTITY_KEYS in the rows). */
const maskRow = <T extends IdentityCells>(row: T): T => ({
  ...row,
  idNumber: row.idNumber ? maskIdentity(row.idNumber) : '',
  dateOfBirth: row.dateOfBirth ? HIDDEN_DATE : '',
  passportExpiry: row.passportExpiry ? HIDDEN_DATE : '',
});
/** A body corporate's registration number is public record, as `personForActor` treats it. */
const BODY_CORPORATE = 'Body corporate';

/**
 * The return's values with every individual's ID number, date of birth and passport expiry
 * masked: officers, individual members, joint holders and the subjects of trust holdings. The
 * workbook is always filled from unmasked values; this is for showing the return on screen.
 */
export function maskAr1Data(data: Ar1Data): Ar1Data {
  return {
    ...data,
    d: {
      ...data.d,
      directors: data.d.directors.map(maskRow),
      managers: data.d.managers.map(maskRow),
      secretaries: data.d.secretaries.map(maskRow),
    },
    e: {
      members: data.e.members.map((r) => (r.memberType === BODY_CORPORATE ? r : maskRow(r))),
      subclassification: data.e.subclassification.map((r) =>
        r.type === BODY_CORPORATE ? r : maskRow(r),
      ),
    },
  };
}
